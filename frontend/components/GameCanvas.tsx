import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer';
import { initializeSocket, disconnectSocket, getSocket, isSocketReady, getSocketStatus } from '../game/network/socket';
import { Player } from '../types/player';
import ChatPanel from './ui/ChatPanel';
import InventoryPanel from './ui/InventoryPanel';
import soundManager from '../game/audio/soundManager';
import { 
  ResourceNode, 
  ResourceType, 
  WorldItem, 
  createResourceMesh, 
  createItemMesh,
  updateDroppedItems
} from '../game/world/resources';

// Player movement speed
const MOVEMENT_SPEED = 0.15;
// World boundaries
const WORLD_BOUNDS = {
  minX: -50, 
  maxX: 50,
  minZ: -50,
  maxZ: 50
};

const GameCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<THREE.Mesh | null>(null);
  const playersRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const resourceNodesRef = useRef<ResourceNode[]>([]);
  const worldItemsRef = useRef<WorldItem[]>([]);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2());
  const clockRef = useRef<THREE.Clock>(new THREE.Clock());
  const labelRendererRef = useRef<CSS2DRenderer | null>(null);
  const cleanupIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Add a ref for cleanup functions so they can be accessed outside useEffect
  const cleanupFunctionsRef = useRef<{
    initialCleanup?: () => void;
    cleanupPlayerMeshes?: () => void;
  }>({});
  
  const [playerName, setPlayerName] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [currentZone, setCurrentZone] = useState<string>('Lumbridge');
  
  // Store key states
  const keysPressed = useRef<Record<string, boolean>>({
    w: false,
    a: false,
    s: false,
    d: false,
    ArrowUp: false,
    ArrowLeft: false,
    ArrowDown: false,
    ArrowRight: false
  });
  
  // Add camera control state
  const isMiddleMouseDown = useRef(false);
  const lastMousePosition = useRef({ x: 0, y: 0 });
  const cameraDistance = useRef(10);
  const cameraAngle = useRef(0);
  const cameraTilt = useRef(0.5); // Add camera tilt angle (0 to 1, where 0.5 is horizontal)
  
  // Track the player's last sent position to avoid spamming movement updates
  const lastSentPosition = useRef({ x: 0, y: 1, z: 0 });
  const lastSendTime = useRef(0);
  const SEND_INTERVAL = 100; // Send updates at most every 100ms
  
  // Track if player movement has changed since last send
  const movementChanged = useRef(false);
  
  // Add position history tracking to detect anomalous movements
  const positionHistory = useRef<Array<{x: number, z: number, time: number}>>([]);
  const MAX_HISTORY_LENGTH = 5;
  const ANOMALOUS_SPEED_THRESHOLD = 1.0; // Units per second
  
  // Keep track of gathering cooldown
  const isGathering = useRef(false);
  
  // Add sound toggle state
  const [soundEnabled, setSoundEnabled] = useState(true);
  
  // Create a ref to store the createNameLabel function
  const createNameLabelRef = useRef<((name: string, mesh: THREE.Mesh) => CSS2DObject) | null>(null);
  
  // Add a ref to track all name labels in the scene for proper cleanup
  const nameLabelsRef = useRef<Map<string, CSS2DObject>>(new Map());
  
  // Add state to track if cleanup is in progress
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  
  // Game references
  const chatBubblesRef = useRef<Map<string, { object: CSS2DObject, expiry: number }>>(new Map());
  
  // Add movement state
  const moveForward = useRef(false);
  const moveBackward = useRef(false);
  const moveLeft = useRef(false);
  const moveRight = useRef(false);
  const isJumping = useRef(false);
  const jumpVelocity = useRef(0);
  const lastUpdateTime = useRef(0);
  const JUMP_FORCE = 0.3;
  const GRAVITY = 0.015;
  const JUMP_COOLDOWN = 500; // milliseconds
  const lastJumpTime = useRef(0);
  
  useEffect(() => {
    // Init socket on component mount
    async function connectSocket() {
      const socket = await initializeSocket();
      
      // If no socket (not authenticated), redirect to login
      if (!socket) {
        window.location.href = '/auth/signin';
        return;
      }
      
      // Track socket connection state
      socket.on('connect', () => {
        console.log('Socket connected with ID:', socket.id);
        setIsConnected(true);
        
        // Clear player refs on reconnect to avoid stale references
        if (playersRef.current.size > 0) {
          console.log('Clearing player references on reconnect to avoid stale data');
          playersRef.current = new Map();
        }
      });
      
      socket.on('disconnect', () => {
        console.log('Socket disconnected, updating connection state');
        setIsConnected(false);
      });

      // Add custom event listeners for socket state changes
      const handleSocketConnected = () => {
        console.log('Socket connected event received');
        setIsConnected(true);
      };
      
      const handleSocketDisconnected = () => {
        console.log('Socket disconnected event received');
        setIsConnected(false);
      };
      
      window.addEventListener('socket_connected', handleSocketConnected);
      window.addEventListener('socket_disconnected', handleSocketDisconnected);
      
      // Initial connection state
      setIsConnected(socket.connected);

      // Monitor actual connection state periodically
      const connectionMonitor = setInterval(() => {
        const status = getSocketStatus();
        if (status.connected !== isConnected) {
          console.log(`Connection state mismatch - status: ${status.connected}, state: ${isConnected}`);
          setIsConnected(status.connected);
        }
      }, 5000);
      
      return () => {
        // Disconnect socket on unmount
        disconnectSocket();
        
        // Clean up event listeners
        window.removeEventListener('socket_connected', handleSocketConnected);
        window.removeEventListener('socket_disconnected', handleSocketDisconnected);
        
        clearInterval(connectionMonitor);
      };
    }
    
    connectSocket();
  }, []);
  
  // Update sound manager when sound enabled state changes
  useEffect(() => {
    soundManager.setEnabled(soundEnabled);
  }, [soundEnabled]);
  
  // Add name label to player when name is set
  useEffect(() => {
    if (playerRef.current && playerName && createNameLabelRef.current) {
      createNameLabelRef.current(playerName, playerRef.current);
    }
  }, [playerName]);
  
  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Initialize Three.js scene
    const scene = new THREE.Scene();
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(
      75, 
      window.innerWidth / window.innerHeight, 
      0.1, 
      1000
    );
    camera.position.set(0, 10, 10);
    camera.lookAt(0, 0, 0);
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(new THREE.Color('#87CEEB')); // Sky blue color
    
    // Create CSS2D renderer for name labels
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    canvasRef.current.appendChild(labelRenderer.domElement);
    labelRendererRef.current = labelRenderer;
    
    // Append canvas to DOM
    canvasRef.current.appendChild(renderer.domElement);
    
    // Handle window resize
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      
      renderer.setSize(width, height);
      labelRenderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);
    
    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    // Add directional light (sun)
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    scene.add(directionalLight);
    
    // Create a ground plane
    const groundGeometry = new THREE.PlaneGeometry(100, 100);
    const groundMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x4caf50,  // Green color for grass
      roughness: 0.8,
      metalness: 0.2
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    
    // Rotate the ground to be horizontal (x-z plane)
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);
    
    // Create a simple grid for reference
    const gridHelper = new THREE.GridHelper(100, 20);
    scene.add(gridHelper);
    
    // Add boundary visualizers for debugging
    const createBoundaryMarkers = () => {
      // Use a bright color for visibility
      const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      const markerGeometry = new THREE.SphereGeometry(0.5);
      
      // Place markers at corners and midpoints of the world boundaries
      const boundaryPoints = [
        // Corners
        { x: WORLD_BOUNDS.minX, z: WORLD_BOUNDS.minZ },
        { x: WORLD_BOUNDS.minX, z: WORLD_BOUNDS.maxZ },
        { x: WORLD_BOUNDS.maxX, z: WORLD_BOUNDS.minZ },
        { x: WORLD_BOUNDS.maxX, z: WORLD_BOUNDS.maxZ },
        // Midpoints of edges
        { x: WORLD_BOUNDS.minX, z: 0 },
        { x: WORLD_BOUNDS.maxX, z: 0 },
        { x: 0, z: WORLD_BOUNDS.minZ },
        { x: 0, z: WORLD_BOUNDS.maxZ },
      ];
      
      // Create and add markers to scene
      boundaryPoints.forEach(point => {
        const marker = new THREE.Mesh(markerGeometry, markerMaterial);
        marker.position.set(point.x, 1, point.z); // Position at y=1 to be visible above ground
        scene.add(marker);
      });
      
      // Create visible lines along the boundaries
      const lineGeometry = new THREE.BufferGeometry();
      const lineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
      
      // Define the outline of the world boundary box (on ground level)
      const linePoints = [
        // Bottom square
        new THREE.Vector3(WORLD_BOUNDS.minX, 0.1, WORLD_BOUNDS.minZ),
        new THREE.Vector3(WORLD_BOUNDS.maxX, 0.1, WORLD_BOUNDS.minZ),
        new THREE.Vector3(WORLD_BOUNDS.maxX, 0.1, WORLD_BOUNDS.maxZ),
        new THREE.Vector3(WORLD_BOUNDS.minX, 0.1, WORLD_BOUNDS.maxZ),
        new THREE.Vector3(WORLD_BOUNDS.minX, 0.1, WORLD_BOUNDS.minZ)
      ];
      
      lineGeometry.setFromPoints(linePoints);
      const boundaryLine = new THREE.Line(lineGeometry, lineMaterial);
      scene.add(boundaryLine);
      
      console.log('Boundary markers created at world bounds', WORLD_BOUNDS);
    };
    
    // Enable boundary markers for debugging
    // Comment out in production if not needed
    createBoundaryMarkers();
    
    // Create player avatar (a simple box for now)
    const playerGeometry = new THREE.BoxGeometry(1, 2, 1);
    const playerMaterial = new THREE.MeshStandardMaterial({
      color: 0x2196f3, // Blue color for player
    });
    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
    
    // Position player slightly above ground to avoid z-fighting
    playerMesh.position.set(0, 1, 0);
    
    // Save player mesh to ref for later access
    playerRef.current = playerMesh;
    
    // Add player to scene
    scene.add(playerMesh);
    
    // Create name label for player
    const createNameLabel = (name: string, mesh: THREE.Mesh) => {
      // Get player ID
      const playerId = mesh.userData.playerId;
      
      // Remove any existing label for this player from the scene and ref
      if (playerId && nameLabelsRef.current.has(playerId)) {
        const existingLabel = nameLabelsRef.current.get(playerId);
        if (existingLabel) {
          // Remove from parent if it has one
          if (existingLabel.parent) {
            existingLabel.parent.remove(existingLabel);
          }
          // Also remove from scene directly to be sure
          scene.remove(existingLabel);
          // Remove from our tracking map
          nameLabelsRef.current.delete(playerId);
        }
      }
      
      // Remove existing labels from the mesh to avoid duplicates
      const childrenToRemove: THREE.Object3D[] = [];
      mesh.children.forEach(child => {
        if ((child as any).isCSS2DObject) {
          childrenToRemove.push(child);
        }
      });
      
      // Remove the children outside the loop
      childrenToRemove.forEach(child => {
        mesh.remove(child);
        scene.remove(child);
      });
      
      // Create new label
      const nameDiv = document.createElement('div');
      nameDiv.className = 'player-label';
      nameDiv.textContent = name;
      nameDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
      nameDiv.style.color = 'white';
      nameDiv.style.padding = '2px 6px';
      nameDiv.style.borderRadius = '3px';
      nameDiv.style.fontSize = '12px';
      nameDiv.style.fontFamily = 'Arial, sans-serif';
      nameDiv.style.fontWeight = 'bold';
      nameDiv.style.textAlign = 'center';
      nameDiv.style.userSelect = 'none';
      nameDiv.style.pointerEvents = 'none'; // Make sure labels don't interfere with clicks
      
      const nameLabel = new CSS2DObject(nameDiv);
      nameLabel.position.set(0, 2.5, 0); // Position above the player
      nameLabel.userData.labelType = 'playerName';
      nameLabel.userData.forPlayer = playerId;
      
      // Add to tracking map if we have a playerId
      if (playerId) {
        nameLabelsRef.current.set(playerId, nameLabel);
      }
      
      // Add to mesh
      mesh.add(nameLabel);
      return nameLabel;
    };
    
    // Store the createNameLabel function in the ref so it can be used by other useEffect hooks
    createNameLabelRef.current = createNameLabel;
    
    // Create resource nodes in the world
    const createWorldResources = () => {
      // Clear existing resources
      resourceNodesRef.current.forEach(node => {
        if (node.mesh) {
          scene.remove(node.mesh);
        }
      });
      resourceNodesRef.current = [];
      
      // Define resource nodes
      const resources: ResourceNode[] = [
        // Trees in Lumbridge area
        { id: 'tree-1', type: ResourceType.TREE, x: 10, y: 0, z: 10 },
        { id: 'tree-2', type: ResourceType.TREE, x: 15, y: 0, z: 15 },
        { id: 'tree-3', type: ResourceType.TREE, x: 20, y: 0, z: 10 },
        
        // Rocks in Barbarian Village
        { id: 'rock-1', type: ResourceType.ROCK, x: -20, y: 0, z: -20 },
        { id: 'rock-2', type: ResourceType.ROCK, x: -25, y: 0, z: -15 },
        
        // Fishing spots
        { id: 'fish-1', type: ResourceType.FISH, x: 30, y: 0, z: -30 },
      ];
      
      // Create meshes for each resource and add to scene
      resources.forEach(resource => {
        const mesh = createResourceMesh(resource.type);
        mesh.position.set(resource.x, resource.y, resource.z);
        
        // Store resource ID in userData for raycasting identification
        mesh.userData.resourceId = resource.id;
        mesh.userData.resourceType = resource.type;
        
        scene.add(mesh);
        
        // Store reference to mesh in resource node
        resourceNodesRef.current.push({
          ...resource,
          mesh: mesh as THREE.Mesh
        });
      });
    };
    
    // Initialize resources
    createWorldResources();
    
    // Set up socket event listeners
    const setupSocketListeners = async () => {
      const socket = await getSocket();
      if (!socket) return;
      
      // Function to create a player mesh
      const createPlayerMesh = (player: Player) => {
        // First check if this is the player's own character
        if (socket.id === player.id) {
          console.log('Attempted to create mesh for own player, skipping:', player);
          return null;
        }
        
        console.log(`Creating mesh for player ${player.id}`, {
          playerExists: playersRef.current.has(player.id),
          position: { x: player.x, y: player.y, z: player.z }
        });
        
        // Find any existing meshes for this player to ensure proper cleanup
        const existingMeshes: THREE.Object3D[] = [];
        
        // Check in playersRef first
        if (playersRef.current.has(player.id)) {
          const knownMesh = playersRef.current.get(player.id);
          if (knownMesh) {
            existingMeshes.push(knownMesh);
          }
        }
        
        // Also search the entire scene for duplicates
        scene.traverse((object) => {
          if (object.userData && object.userData.playerId === player.id) {
            // Only add to our list if not already in existingMeshes
            if (!existingMeshes.includes(object)) {
              existingMeshes.push(object);
            }
          }
        });
        
        // Clean up all existing meshes for this player
        existingMeshes.forEach(mesh => {
          // First remove any CSS2DObjects
          mesh.traverse((child) => {
            if ((child as any).isCSS2DObject) {
              if (child.parent) {
                child.parent.remove(child);
              }
              scene.remove(child);
            }
          });
          
          // Clean up any object data
          if ((mesh as THREE.Mesh).geometry) {
            (mesh as THREE.Mesh).geometry.dispose();
          }
          
          // Clean up materials
          if ((mesh as THREE.Mesh).material) {
            if (Array.isArray((mesh as THREE.Mesh).material)) {
              ((mesh as THREE.Mesh).material as THREE.Material[]).forEach((material: THREE.Material) => material.dispose());
            } else {
              ((mesh as THREE.Mesh).material as THREE.Material).dispose();
            }
          }
          
          // Remove from scene
          scene.remove(mesh);
        });
        
        // Remove from our tracking references
        playersRef.current.delete(player.id);
            
        // Remove from name labels ref
        if (nameLabelsRef.current.has(player.id)) {
          const label = nameLabelsRef.current.get(player.id);
          if (label) {
            if (label.parent) {
              label.parent.remove(label);
            }
            scene.remove(label);
            nameLabelsRef.current.delete(player.id);
          }
        }
        
        // Create new player mesh
        const otherPlayerGeometry = new THREE.BoxGeometry(1, 2, 1);
        const otherPlayerMaterial = new THREE.MeshStandardMaterial({
          color: 0xff5722, // Orange color for other players
        });
        const otherPlayerMesh = new THREE.Mesh(otherPlayerGeometry, otherPlayerMaterial);
        
        // Set position from player data
        otherPlayerMesh.position.set(player.x, player.y, player.z);
        
        // Store player data in userData
        otherPlayerMesh.userData.playerId = player.id;
        otherPlayerMesh.userData.playerName = player.name;
        
        // Add name label
        createNameLabel(player.name, otherPlayerMesh);
        
        // Add to scene
        scene.add(otherPlayerMesh);
        
        // Store in players map
        playersRef.current.set(player.id, otherPlayerMesh);
        
        console.log(`Player mesh created and added to tracking for ${player.id}`, {
          meshCreated: !!otherPlayerMesh,
          position: otherPlayerMesh.position,
          inTrackingMap: playersRef.current.has(player.id),
          trackedMeshId: playersRef.current.get(player.id)?.id
        });
        
        return otherPlayerMesh;
      };
      
      // Handle initial players
      socket.on('initPlayers', (players) => {
        console.log('Received initial players:', players);
        
        // Run cleanup to remove any potential duplicates before adding new players
        cleanupPlayerMeshes();
        
        // Store the player's own ID when receiving initial players
        // This helps differentiate the local player from others
        if (!socket.id) {
          console.warn('Socket ID not available when initializing players');
        } else {
          // Set player name from the player data if it exists
          const ownPlayerData = players.find(p => p.id === socket.id);
          if (ownPlayerData) {
            setPlayerName(ownPlayerData.name);
          }
        }
        
        // Log all players for debugging
        console.log('All players in initPlayers:', {
          count: players.length,
          ids: players.map(p => p.id),
          socketId: socket.id
        });
        
        // Add each existing player to the scene
        players.forEach(player => {
          // Skip creating a mesh for the current player to avoid duplication
          if (player.id === socket.id) {
            console.log('Skipping creating mesh for own player:', player);
            // Position the local player at their saved position
            if (playerRef.current) {
              playerRef.current.position.set(player.x, player.y, player.z);
              
              // Store player data in userData
              playerRef.current.userData.playerId = player.id;
              playerRef.current.userData.playerName = player.name;
            }
            return;
          }
          
          console.log(`Creating mesh for player: ${player.id} (${player.name})`);
          createPlayerMesh(player);
        });
        
        // Log player tracking state after initialization
        console.log('Player tracking state after init:', {
          trackedPlayers: Array.from(playersRef.current.keys()),
          count: playersRef.current.size
        });
      });
      
      // Handle new player joins
      socket.on('playerJoined', (player) => {
        console.log('Player joined:', player);
        
        // Play sound for new player joining
        soundManager.play('playerJoin');
        
        // Check if this is the local player (shouldn't happen but as a safety measure)
        if (player.id === socket.id) {
          console.log('Received playerJoined for self, adjusting local player:', player);
          
          // Update local player position instead of creating a new mesh
          if (playerRef.current) {
            playerRef.current.position.set(player.x, player.y, player.z);
            
            // Ensure player name is set
            setPlayerName(player.name);
            
            // Update player data in userData
            playerRef.current.userData.playerId = player.id;
            playerRef.current.userData.playerName = player.name;
          }
          return;
        }
        
        // Log current players before adding new one for debugging
        console.log('Player tracking BEFORE adding new player:', {
          trackedPlayers: Array.from(playersRef.current.keys()),
          count: playersRef.current.size
        });
        
        // Check if we already have this player in our map and remove it first
        if (playersRef.current.has(player.id)) {
          console.log(`Player ${player.id} already exists in tracker, cleaning up first`);
          const existingMesh = playersRef.current.get(player.id);
          if (existingMesh) {
            // Remove any CSS2DObjects first
            existingMesh.traverse((child) => {
              if ((child as any).isCSS2DObject) {
                if (child.parent) {
                  child.parent.remove(child);
                }
                scene.remove(child);
              }
            });
            
            // Clean up resources
            if ((existingMesh as THREE.Mesh).geometry) {
              (existingMesh as THREE.Mesh).geometry.dispose();
            }
            if ((existingMesh as THREE.Mesh).material) {
              if (Array.isArray((existingMesh as THREE.Mesh).material)) {
                ((existingMesh as THREE.Mesh).material as THREE.Material[]).forEach(m => m.dispose());
              } else {
                ((existingMesh as THREE.Mesh).material as THREE.Material).dispose();
              }
            }
            
            // Remove from scene
            scene.remove(existingMesh);
            playersRef.current.delete(player.id);
          }
        }
        
        // Always use createPlayerMesh which handles existing players properly
        const createdMesh = createPlayerMesh(player);
        
        // Verify the player was properly added
        console.log('Player tracking AFTER adding new player:', {
          trackedPlayers: Array.from(playersRef.current.keys()),
          playerAdded: playersRef.current.has(player.id),
          meshCreated: !!createdMesh
        });
      });
      
      // Handle player disconnects
      socket.on('playerLeft', (playerId) => {
        console.log('Player left:', playerId);
        
        // Skip if this is the local player ID (we shouldn't remove ourselves)
        if (playerId === socket.id) {
          console.warn('Received playerLeft for local player, ignoring');
          return;
        }
        
        // First, remove any name label from our tracking map and the scene
        if (nameLabelsRef.current.has(playerId)) {
          const label = nameLabelsRef.current.get(playerId);
          if (label) {
            // Remove from parent if it has one
            if (label.parent) {
              label.parent.remove(label);
            }
            // Also remove from scene directly to be sure
            scene.remove(label);
          }
          // Remove from our map
          nameLabelsRef.current.delete(playerId);
        }
        
        // Remove player mesh from scene
        const playerMesh = playersRef.current.get(playerId);
        if (playerMesh) {
          // First remove any attached CSS2DObjects directly
          const childrenToRemove: THREE.Object3D[] = [];
          playerMesh.traverse((child) => {
            if ((child as any).isCSS2DObject) {
              childrenToRemove.push(child);
            }
          });
          
          // Remove the children outside the traversal
          childrenToRemove.forEach(child => {
            if (child.parent) {
              child.parent.remove(child);
            }
            scene.remove(child);
          });
          
          // Clean up any object data
          if (playerMesh.geometry) playerMesh.geometry.dispose();
          if (Array.isArray(playerMesh.material)) {
            playerMesh.material.forEach(material => material.dispose());
          } else if (playerMesh.material) {
            playerMesh.material.dispose();
          }
          
          // Remove from scene
          scene.remove(playerMesh);
          playersRef.current.delete(playerId);
        }
        
        // Additional safety check - look for any orphaned labels in the scene
        scene.traverse((object) => {
          if ((object as any).isCSS2DObject && 
              object.userData && 
              object.userData.forPlayer === playerId) {
            if (object.parent) {
              object.parent.remove(object);
            }
            scene.remove(object);
          }
        });
      });
      
      // Handle player sync request from server - compare local tracking to server's list of player IDs
      socket.on('checkPlayersSync', (playerIds, callback) => {
        console.log('Received checkPlayersSync request:', {
          serverPlayerIds: playerIds,
          localPlayerIds: Array.from(playersRef.current.keys())
        });
        
        // Find players that we're missing locally (on server but not tracked locally)
        const missingPlayerIds = playerIds.filter(id => !playersRef.current.has(id));
        
        console.log(`Client is missing ${missingPlayerIds.length} players:`, missingPlayerIds);
        
        // Send back the list of missing players
        callback(missingPlayerIds);
      });
      
      // Handle player movements
      socket.on('playerMoved', (data) => {
        // Add verbose logging for debugging
        console.log('Received playerMoved event:', {
          playerId: data.id,
          position: { x: data.x, y: data.y, z: data.z },
          playerExists: playersRef.current.has(data.id),
          totalPlayers: playersRef.current.size,
          allPlayerIds: Array.from(playersRef.current.keys())
        });
        
        // Skip if this is our own player ID - we shouldn't move ourselves based on server events
        // This is a fallback in case we broadcast to all instead of socket.broadcast
        if (data.id === socket.id || data.id === 'TEST-' + socket.id) {
          console.log('Skipping movement update for own player');
          return;
        }
        
        // Update the position of the moved player
        const playerMesh = playersRef.current.get(data.id);
        if (playerMesh) {
          // Ensure received positions are within bounds before applying
          const validX = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, data.x));
          const validZ = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, data.z));
          
          console.log(`Updating position for player ${data.id} to:`, {
            x: validX,
            y: data.y,
            z: validZ
          });
          
          // Calculate distance to new position
          const currentPos = playerMesh.position;
          const distanceToNewPos = Math.sqrt(
            Math.pow(validX - currentPos.x, 2) + 
            Math.pow(validZ - currentPos.z, 2)
          );
          
          // If distance is very large, smooth the transition
          const LARGE_MOVEMENT_THRESHOLD = 5; // Units
          if (distanceToNewPos > LARGE_MOVEMENT_THRESHOLD) {
            console.warn(`Large position change detected for player ${data.id}: ${distanceToNewPos.toFixed(2)} units`);
            
            // Instead of immediate jump, move halfway there
            // This creates a smoother transition for large changes
            const midX = currentPos.x + (validX - currentPos.x) * 0.5;
            const midZ = currentPos.z + (validZ - currentPos.z) * 0.5;
            
            playerMesh.position.set(midX, data.y, midZ);
          } else {
            // Normal update for reasonable distances
            playerMesh.position.set(validX, data.y, validZ);
          }
        } else {
          console.warn(`Could not find player mesh for ID: ${data.id}. Attempting to create it.`);
          
          // This case can happen if we receive a playerMoved event before playerJoined
          // Try to fetch the player from the server to create the mesh
          socket.emit('getPlayerData', data.id, (playerData) => {
            if (playerData) {
              console.log(`Received player data for missing player ${data.id}, creating mesh`);
              const createdMesh = createPlayerMesh(playerData);
              console.log(`Created mesh for player ${data.id} after getPlayerData response`, {
                success: !!createdMesh,
                trackedPlayers: Array.from(playersRef.current.keys()),
                playerTracked: playersRef.current.has(data.id)
              });
            } else {
              // If server doesn't respond with player data, create a minimal player object
              const minimalPlayer = {
                id: data.id,
                name: `Player-${data.id.substring(0, 4)}`,
                x: data.x,
                y: data.y,
                z: data.z,
                userId: ''
              };
              console.log(`Creating minimal player object for ${data.id}`);
              const createdMesh = createPlayerMesh(minimalPlayer);
              console.log(`Created mesh for minimal player ${data.id}`, {
                success: !!createdMesh,
                trackedPlayers: Array.from(playersRef.current.keys()),
                playerTracked: playersRef.current.has(data.id)
              });
            }
          });
        }
      });
      
      // Handle item drops in the world
      socket.on('itemDropped', (data) => {
        console.log('Item dropped:', data);
        
        // Play drop sound
        soundManager.play('itemDrop');
        
        // Create a mesh for the dropped item
        const itemMesh = createItemMesh(data.itemType);
        itemMesh.position.set(data.x, data.y, data.z);
        
        // Store the item ID in userData for raycasting identification
        itemMesh.userData.dropId = data.dropId;
        
        // Add to scene
        scene.add(itemMesh);
        
        // Store reference in worldItems
        worldItemsRef.current.push({
          ...data,
          mesh: itemMesh
        });
      });
      
      // Handle item removals
      socket.on('itemRemoved', (dropId) => {
        console.log('Item removed:', dropId);
        
        // Find the item in our world items
        const itemIndex = worldItemsRef.current.findIndex(item => item.dropId === dropId);
        
        if (itemIndex !== -1) {
          const item = worldItemsRef.current[itemIndex];
          
          // Remove from scene if it has a mesh
          if (item.mesh) {
            scene.remove(item.mesh);
            if (item.mesh.geometry) item.mesh.geometry.dispose();
            if (Array.isArray(item.mesh.material)) {
              item.mesh.material.forEach(material => material.dispose());
            } else if (item.mesh.material) {
              item.mesh.material.dispose();
            }
          }
          
          // Remove from our list
          worldItemsRef.current.splice(itemIndex, 1);
        }
      });
      
      // Listen for chat messages
      socket.on('chatMessage', (message: { 
        name: string; 
        text: string; 
        playerId: string; 
        timestamp: number;
      }) => {
        console.log('Chat message received for bubble creation:', message);
        
        // If this is our own message, add a chat bubble above our player
        if (message.playerId === socket.id && playerRef.current) {
          createChatBubble(message.playerId, message.text, playerRef.current);
        } 
        // If it's another player's message, find their mesh and add a bubble
        else if (message.playerId && playersRef.current.has(message.playerId)) {
          const playerMesh = playersRef.current.get(message.playerId);
          if (playerMesh) {
            createChatBubble(message.playerId, message.text, playerMesh);
          }
        }
        
        // Sound is now handled exclusively by ChatPanel component
      });
      
      // Add a function to perform thorough player mesh cleanup to prevent duplicates
      const cleanupPlayerMeshes = () => {
        console.log('Running aggressive player mesh cleanup');
        
        // Helper function to remove a player object and clean up resources
        const removePlayerObject = (object: THREE.Object3D) => {
          // Remove any CSS2DObjects first
          object.traverse((child) => {
            if ((child as any).isCSS2DObject) {
              if (child.parent) {
                child.parent.remove(child);
              }
              scene.remove(child);
            }
          });
          
          // Clean up geometry and materials if it's a mesh
          if ((object as THREE.Mesh).geometry) {
            (object as THREE.Mesh).geometry.dispose();
          }
          if ((object as THREE.Mesh).material) {
            if (Array.isArray((object as THREE.Mesh).material)) {
              ((object as THREE.Mesh).material as THREE.Material[]).forEach(
                (material: THREE.Material) => material.dispose()
              );
            } else {
              ((object as THREE.Mesh).material as THREE.Material).dispose();
            }
          }
          
          // Remove from scene
          scene.remove(object);
        };
        
        // Get a list of valid player IDs we should keep (all players currently in the game)
        const validPlayerIds = new Set<string>();
        // Add IDs from our player reference map
        playersRef.current.forEach((_, id) => validPlayerIds.add(id));
        // Always consider our own player ID valid
        if (socket.id) validPlayerIds.add(socket.id);
        
        console.log('Valid player IDs:', Array.from(validPlayerIds));
        
        // First, do a full scene traversal to find ALL player-related objects
        const allPlayerObjects: THREE.Object3D[] = [];
        const playerIdToObjects = new Map<string, THREE.Object3D[]>();
        
        scene.traverse((object) => {
          // Check if this is a player mesh by checking for specific properties
          if (object.userData && object.userData.playerId) {
            const playerId = object.userData.playerId;
            allPlayerObjects.push(object);
            
            // Group by player ID
            if (!playerIdToObjects.has(playerId)) {
              playerIdToObjects.set(playerId, []);
            }
            playerIdToObjects.get(playerId)?.push(object);
          }
        });
        
        console.log(`Found ${allPlayerObjects.length} total player-related objects in scene`);
        
        // Process objects by player ID to handle cleanup
        playerIdToObjects.forEach((objects, playerId) => {
          // If this player ID is no longer valid, remove ALL its objects
          if (!validPlayerIds.has(playerId)) {
            console.log(`Removing all objects for invalid player ${playerId}`);
            objects.forEach(removePlayerObject);
            
            // Also make sure it's removed from our playersRef
            playersRef.current.delete(playerId);
            
            // And from name labels
            if (nameLabelsRef.current.has(playerId)) {
              const label = nameLabelsRef.current.get(playerId);
              if (label) {
                if (label.parent) {
                  label.parent.remove(label);
                }
                scene.remove(label);
                nameLabelsRef.current.delete(playerId);
              }
            }
          } else if (playerId === socket.id) {
            // This is our own player, we should only have our main player mesh
            console.log(`Processing own player objects, found ${objects.length}`);
            
            // Keep only the original playerRef
            objects.forEach(obj => {
              if (obj !== playerRef.current) {
                console.log('Removing duplicate of own player');
                removePlayerObject(obj);
              }
            });
          } else {
            // This is another player, we should only have one main mesh per player
            console.log(`Processing player ${playerId}, found ${objects.length} objects`);
            
            // Keep only the one tracked in playersRef
            const trackedMesh = playersRef.current.get(playerId);
            if (trackedMesh) {
              objects.forEach(obj => {
                if (obj !== trackedMesh && obj.type === 'Mesh') {
                  console.log(`Removing duplicate mesh for player ${playerId}`);
                  removePlayerObject(obj);
                }
              });
            }
          }
        });
        
        // Check for orphaned name labels (not attached to any player)
        nameLabelsRef.current.forEach((label, playerId) => {
          if (!playerIdToObjects.has(playerId)) {
            console.log(`Removing orphaned name label for player ${playerId}`);
            if (label.parent) {
              label.parent.remove(label);
            }
            scene.remove(label);
            nameLabelsRef.current.delete(playerId);
          }
        });
      };
      
      // Set up periodic cleanup to handle any ghost player meshes
      const cleanupInterval = setInterval(() => {
        if (isConnected) {
          cleanupPlayerMeshes();
        }
      }, 30000); // Run cleanup every 30 seconds
      
      // Store the interval for cleanup
      cleanupIntervalRef.current = cleanupInterval;
    };
    
    setupSocketListeners();
    
    // Handle keyboard input
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the key is one we track for movement
      if (keysPressed.current.hasOwnProperty(event.key)) {
        keysPressed.current[event.key] = true;
      }
    };
    
    const handleKeyUp = (event: KeyboardEvent) => {
      // Check if the key is one we track for movement
      if (keysPressed.current.hasOwnProperty(event.key)) {
        keysPressed.current[event.key] = false;
      }
    };
    
    // Handle mouse click for resource gathering and item pickup
    const handleMouseClick = (event: MouseEvent) => {
      // Get mouse position in normalized device coordinates (-1 to +1)
      const rect = renderer.domElement.getBoundingClientRect();
      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      
      // Update the raycaster
      raycasterRef.current.setFromCamera(mouseRef.current, camera);
      
      // Create a list of objects to check for intersection
      const interactables = [
        ...resourceNodesRef.current.map(node => node.mesh),
        ...worldItemsRef.current.map(item => item.mesh)
      ].filter(Boolean) as THREE.Object3D[];
      
      // Perform raycasting
      const intersects = raycasterRef.current.intersectObjects(interactables);
      
      if (intersects.length > 0) {
        const intersected = intersects[0].object;
        
        // Calculate distance to player
        const playerPosition = playerRef.current?.position || new THREE.Vector3();
        const distanceToPlayer = playerPosition.distanceTo(intersected.position);
        
        // Check if it's a resource node
        if (intersected.userData.resourceId && distanceToPlayer <= 5) {
          // Gather resource if not already gathering
          if (!isGathering.current) {
            gatherResource(intersected.userData.resourceId);
          }
        }
        // Check if it's a dropped item
        else if (intersected.userData.dropId && distanceToPlayer <= 5) {
          // Pick up item
          pickupItem(intersected.userData.dropId);
        }
        // Too far away
        else if (distanceToPlayer > 5) {
          console.log('Too far away to interact!');
        }
      }
    };
    
    // Add event listeners for keyboard and mouse
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    renderer.domElement.addEventListener('click', handleMouseClick);
    
    // Add mouse event handlers for camera control
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 1) { // Middle mouse button
        console.log('Middle mouse button pressed');
        isMiddleMouseDown.current = true;
        lastMousePosition.current = { x: event.clientX, y: event.clientY };
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button === 1) { // Middle mouse button
        console.log('Middle mouse button released');
        isMiddleMouseDown.current = false;
      }
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (isMiddleMouseDown.current) {
        const deltaX = event.clientX - lastMousePosition.current.x;
        const deltaY = event.clientY - lastMousePosition.current.y;
        
        // Update camera angle based on horizontal mouse movement
        // Positive deltaX (moving right) rotates clockwise
        // Negative deltaX (moving left) rotates counter-clockwise
        cameraAngle.current += deltaX * 0.01;

        // Update camera tilt based on vertical mouse movement
        // Positive deltaY (moving down) increases tilt
        // Negative deltaY (moving up) decreases tilt
        cameraTilt.current = Math.max(0.1, Math.min(0.9, cameraTilt.current + deltaY * 0.01));

        lastMousePosition.current = { x: event.clientX, y: event.clientY };
      }
    };

    // Add mouse wheel handler for zoom
    const handleMouseWheel = (event: WheelEvent) => {
      // Update camera distance based on wheel movement
      cameraDistance.current = Math.max(5, Math.min(20, cameraDistance.current + event.deltaY * 0.1));
    };

    // Add event listeners
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('wheel', handleMouseWheel);
    
    // Function to handle resource gathering
    const gatherResource = async (resourceId: string) => {
      console.log('Gathering resource:', resourceId);
      
      // Set gathering flag to prevent spam
      isGathering.current = true;
      
      // Find the resource to play appropriate sound
      const resourceNode = resourceNodesRef.current.find(node => node.id === resourceId);
      if (resourceNode) {
        // Play sound based on resource type
        switch (resourceNode.type) {
          case ResourceType.TREE:
            soundManager.play('woodcutting');
            break;
          case ResourceType.ROCK:
            soundManager.play('mining');
            break;
          case ResourceType.FISH:
            soundManager.play('fishing');
            break;
        }
      }
      
      // Send gather event to server
      const socket = await getSocket();
      if (socket) {
        socket.emit('gather', resourceId);
      }
      
      // Visual feedback (could be improved)
      if (resourceNode && resourceNode.mesh) {
        const originalColor = (resourceNode.mesh.material as THREE.MeshStandardMaterial).color.clone();
        
        // Flash the resource
        (resourceNode.mesh.material as THREE.MeshStandardMaterial).color.set(0xffff00);
        
        // Reset after delay
        setTimeout(() => {
          if (resourceNode.mesh) {
            (resourceNode.mesh.material as THREE.MeshStandardMaterial).color.copy(originalColor);
          }
          // Reset gathering flag after cooldown
          isGathering.current = false;
        }, 2000);
      } else {
        // Reset gathering flag after cooldown if no resource found
        setTimeout(() => {
          isGathering.current = false;
        }, 2000);
      }
    };
    
    // Function to pick up items
    const pickupItem = async (dropId: string) => {
      console.log('Picking up item:', dropId);
      
      // Play sound
      soundManager.play('itemPickup');
      
      // Send pickup event to server
      const socket = await getSocket();
      if (socket) {
        socket.emit('pickup', dropId);
      }
    };
    
    // Update player movement
    const updatePlayerMovement = () => {
      if (!playerRef.current) return;
      
      const currentTime = Date.now();
      const deltaTime = currentTime - lastUpdateTime.current;
      lastUpdateTime.current = currentTime;
      
      // Calculate movement direction based on camera angle (horizontal only)
      const forward = new THREE.Vector3(
        Math.sin(cameraAngle.current),
        0,
        Math.cos(cameraAngle.current)
      );
      const right = new THREE.Vector3(
        Math.sin(cameraAngle.current + Math.PI / 2),
        0,
        Math.cos(cameraAngle.current + Math.PI / 2)
      );
      
      // Calculate movement vector
      const movement = new THREE.Vector3(0, 0, 0);
      if (keysPressed.current.w || keysPressed.current.ArrowUp) movement.sub(forward);
      if (keysPressed.current.s || keysPressed.current.ArrowDown) movement.add(forward);
      if (keysPressed.current.d || keysPressed.current.ArrowRight) movement.add(right);
      if (keysPressed.current.a || keysPressed.current.ArrowLeft) movement.sub(right);
      
      // Normalize movement vector if moving diagonally
      if (movement.length() > 0) {
        movement.normalize();
        
        // Rotate player to face movement direction
        if (playerRef.current) {
          // Calculate the angle of movement in the XZ plane
          const angle = Math.atan2(movement.x, movement.z);
          // Set player rotation to face movement direction
          playerRef.current.rotation.y = angle;
        }
      }
      
      // Apply movement speed
      movement.multiplyScalar(MOVEMENT_SPEED);
      
      // Update player position
      playerRef.current.position.x += movement.x;
      playerRef.current.position.z += movement.z;
      
      // Handle jumping
      if (isJumping.current) {
        playerRef.current.position.y += jumpVelocity.current;
        jumpVelocity.current -= GRAVITY;
        
        // Check if landed
        if (playerRef.current.position.y <= 1) {
          playerRef.current.position.y = 1;
          isJumping.current = false;
          jumpVelocity.current = 0;
        }
      }
    };
    
    // Function to detect anomalous movement (sudden jumps)
    const detectAnomalousMovement = () => {
      const history = positionHistory.current;
      const latest = history[history.length - 1];
      const previous = history[history.length - 2];
      
      // Calculate distance and time between points
      const distance = Math.sqrt(
        Math.pow(latest.x - previous.x, 2) + 
        Math.pow(latest.z - previous.z, 2)
      );
      const timeDiff = (latest.time - previous.time) / 1000; // Convert to seconds
      
      if (timeDiff > 0) {
        const speed = distance / timeDiff;
        
        // If speed exceeds threshold, adjust position
        if (speed > ANOMALOUS_SPEED_THRESHOLD && playerRef.current) {
          console.warn(`Anomalous speed detected: ${speed.toFixed(2)} units/sec`);
          
          // Instead of immediate position correction, apply a smooth transition
          // For now, just cap the movement to a reasonable distance
          const maxAllowedDistance = MOVEMENT_SPEED * 2; // Allow some acceleration but cap it
          
          if (distance > maxAllowedDistance && playerRef.current) {
            // Calculate direction vector
            const dirX = (latest.x - previous.x) / distance;
            const dirZ = (latest.z - previous.z) / distance;
            
            // Limit the movement to max allowed distance
            const cappedX = previous.x + (dirX * maxAllowedDistance);
            const cappedZ = previous.z + (dirZ * maxAllowedDistance);
            
            // Apply clamping again to ensure we're within bounds
            const boundedX = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, cappedX));
            const boundedZ = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, cappedZ));
            
            // Update position
            playerRef.current.position.x = boundedX;
            playerRef.current.position.z = boundedZ;
            
            // Update last position in history
            positionHistory.current[positionHistory.current.length - 1] = {
              x: boundedX, 
              z: boundedZ, 
              time: latest.time
            };
          }
        }
      }
    };
    
    // Update the player's current zone
    const updatePlayerZone = (x: number, z: number) => {
      // Simple zone detection based on position
      let newZone = 'Lumbridge';
      
      if (x < -10 && z < -10) {
        newZone = 'Barbarian Village';
      } else if (x > 25 && z < 0) {
        newZone = 'Fishing Spot';
      } else if (x > 0 && z > 25) {
        newZone = 'Grand Exchange';
      } else if (x < -30 || z < -30 || x > 30 || z > 30) {
        newZone = 'Wilderness';
      }
      
      if (newZone !== currentZone) {
        setCurrentZone(newZone);
      }
    };
    
    // Send position to server at throttled rate
    const sendPositionUpdate = async () => {
      // Make sure we're really connected by checking both state and socket.connected
      if (!playerRef.current || !isConnected) {
        // Debug why we're not sending position
        if (!playerRef.current) {
          console.warn('Not sending position - playerRef.current is null');
        }
        if (!isConnected) {
          console.warn('Not sending position - isConnected state is false');
        }
        if (!movementChanged.current) {
          // Don't log this as it would spam the console
        }
        return;
      }
      
      // Double-check actual socket connectivity to catch any state mismatches
      if (!isSocketReady()) {
        console.warn('Not sending position - socket exists but is not really connected');
        return;
      }
      
      // Immediately reset movement flag if we're not going to send an update
      // This prevents movement from getting "stuck" if we miss an update window
      if (!movementChanged.current) {
        return;
      }
      
      const now = Date.now();
      // Check if we should send an update (throttle)
      if (now - lastSendTime.current >= SEND_INTERVAL) {
        const position = {
          x: playerRef.current.position.x,
          y: playerRef.current.position.y,
          z: playerRef.current.position.z
        };
        
        // Check if position has changed significantly
        const dx = Math.abs(position.x - lastSentPosition.current.x);
        const dz = Math.abs(position.z - lastSentPosition.current.z);
        
        if (dx > 0.01 || dz > 0.01) {
          // Ensure position is still within bounds before sending
          const validX = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, position.x));
          const validZ = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, position.z));
          
          const validatedPosition = {
            x: validX,
            y: position.y,
            z: validZ
          };
          
          try {
            // Send position to server
            const socket = await getSocket();
            if (socket && socket.connected) {
              console.log('Sending playerMove event:', {
                position: validatedPosition,
                socketId: socket.id,
                connected: socket.connected,
                distance: { dx, dz },
                timeSinceLastSend: now - lastSendTime.current
              });
              
              socket.emit('playerMove', validatedPosition);
              
              // Update last sent position and time with validated coordinates
              lastSentPosition.current = { ...validatedPosition };
              lastSendTime.current = now;
            } else {
              // If socket isn't connected despite our state thinking it is, update state
              if (isConnected && (!socket || !socket.connected)) {
                console.warn('Socket not connected despite state saying it is, updating isConnected');
                setIsConnected(false);
              }
              console.warn('Could not send movement - socket is null or disconnected');
            }
          } catch (error) {
            console.error('Error sending position update:', error);
          }
        } else {
          console.log('Position change too small, not sending update', {
            dx, dz,
            minChangeRequired: 0.01
          });
        }
      }
      
      // Reset movement flag
      movementChanged.current = false;
    };
    
    // Create chat bubble above player
    const createChatBubble = (playerId: string, message: string, mesh: THREE.Mesh) => {
      // Remove any existing chat bubble for this player
      if (chatBubblesRef.current.has(playerId)) {
        const existingBubble = chatBubblesRef.current.get(playerId);
        if (existingBubble && existingBubble.object) {
          // Remove from parent if it has one
          if (existingBubble.object.parent) {
            existingBubble.object.parent.remove(existingBubble.object);
          }
          // Also remove from scene directly to be sure
          scene.remove(existingBubble.object);
        }
        // Remove from tracking map
        chatBubblesRef.current.delete(playerId);
      }
      
      // Create bubble div
      const bubbleDiv = document.createElement('div');
      bubbleDiv.className = 'chat-bubble';
      bubbleDiv.textContent = message;
      bubbleDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
      bubbleDiv.style.color = 'white';
      bubbleDiv.style.padding = '5px 10px';
      bubbleDiv.style.borderRadius = '10px';
      bubbleDiv.style.fontSize = '12px';
      bubbleDiv.style.fontFamily = 'Arial, sans-serif';
      bubbleDiv.style.maxWidth = '150px';
      bubbleDiv.style.textAlign = 'center';
      bubbleDiv.style.wordWrap = 'break-word';
      bubbleDiv.style.userSelect = 'none';
      bubbleDiv.style.pointerEvents = 'none'; // Make sure bubbles don't interfere with clicks
      
      // Create the bubble object
      const chatBubble = new CSS2DObject(bubbleDiv);
      chatBubble.position.set(0, 3.2, 0); // Position above the player name
      chatBubble.userData.bubbleType = 'chatBubble';
      chatBubble.userData.forPlayer = playerId;
      
      // Add to mesh
      mesh.add(chatBubble);
      
      // Store in our ref with expiry time (10 seconds from now)
      const expiryTime = Date.now() + 10000; // 10 seconds
      chatBubblesRef.current.set(playerId, { 
        object: chatBubble, 
        expiry: expiryTime 
      });
      
      console.log(`Created chat bubble for player ${playerId}, expires at ${new Date(expiryTime).toLocaleTimeString()}`);
      
      return chatBubble;
    };
    
    // Store createChatBubble in a ref for use in other effects
    const createChatBubbleRef = { current: createChatBubble };
    
    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      
      // Update player movement (delta time is calculated inside updatePlayerMovement)
      updatePlayerMovement();
      
      // Send position updates
      sendPositionUpdate();
      
      // Always update camera to follow player
      if (playerRef.current) {
        const playerPosition = playerRef.current.position;
        
        // Calculate camera position based on angle, tilt, and distance
        const cameraX = playerPosition.x + Math.sin(cameraAngle.current) * cameraDistance.current;
        const cameraZ = playerPosition.z + Math.cos(cameraAngle.current) * cameraDistance.current;
        // Use cameraTilt to adjust height (0.1 to 0.9 maps to roughly 2 to 8 units above player)
        const cameraY = playerPosition.y + (cameraTilt.current * 6 + 2);

        // Update camera position and look at player
        camera.position.set(cameraX, cameraY, cameraZ);
        camera.lookAt(playerPosition);
        camera.updateProjectionMatrix();
      }
      
      // Animate dropped items
      updateDroppedItems(worldItemsRef.current, clockRef.current.getDelta());
      
      // Check for expired chat bubbles
      const now = Date.now();
      const expiredBubbles: string[] = [];
      
      chatBubblesRef.current.forEach((bubble, playerId) => {
        if (now > bubble.expiry) {
          expiredBubbles.push(playerId);
        }
      });
      
      // Remove expired bubbles
      expiredBubbles.forEach(playerId => {
        const bubble = chatBubblesRef.current.get(playerId);
        if (bubble && bubble.object) {
          if (bubble.object.parent) {
            bubble.object.parent.remove(bubble.object);
          }
          scene.remove(bubble.object);
        }
        chatBubblesRef.current.delete(playerId);
      });
      
      // Render scene and labels
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();
    
    // Just before the animate function, add a diagnostic console log to regularly check player tracking
    setInterval(() => {
      // Get current socket reference
      getSocket().then(currentSocket => {
        console.log('PERIODIC PLAYER TRACKING CHECK:', {
          connectedToSocket: !!currentSocket?.connected,
          socketId: currentSocket?.id,
          trackedPlayers: Array.from(playersRef.current.keys()),
          trackedPlayersCount: playersRef.current.size,
          ownPlayerId: currentSocket?.id
        });
      });
    }, 10000); // Check every 10 seconds
    
    // Clean up on unmount
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      renderer.domElement.removeEventListener('click', handleMouseClick);
      
      // Remove socket event listeners
      const cleanup = async () => {
        const socket = await getSocket();
        if (socket) {
          socket.off('initPlayers');
          socket.off('playerJoined');
          socket.off('playerLeft');
          socket.off('playerMoved');
          socket.off('itemDropped');
          socket.off('itemRemoved');
          socket.off('chatMessage');
        }
      };
      
      cleanup();
      
      // Dispose of geometries and materials
      groundGeometry.dispose();
      groundMaterial.dispose();
      playerGeometry.dispose();
      playerMaterial.dispose();
      
      // Clean up all name labels
      nameLabelsRef.current.forEach((label) => {
        if (label.parent) {
          label.parent.remove(label);
        }
        scene.remove(label);
      });
      nameLabelsRef.current.clear();
      
      // Do an additional traversal to catch any remaining CSS2DObjects
      scene.traverse((object) => {
        if ((object as any).isCSS2DObject) {
          if (object.parent) {
            object.parent.remove(object);
          }
          scene.remove(object);
        }
      });
      
      // Dispose of other player meshes
      playersRef.current.forEach((mesh) => {
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(material => material.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      });
      
      // Dispose of resource meshes
      resourceNodesRef.current.forEach((node) => {
        if (node.mesh) {
          scene.remove(node.mesh);
          if (node.mesh.geometry) node.mesh.geometry.dispose();
          if (Array.isArray(node.mesh.material)) {
            node.mesh.material.forEach(material => material.dispose());
          } else if (node.mesh.material) {
            node.mesh.material.dispose();
          }
        }
      });
      
      // Dispose of world item meshes
      worldItemsRef.current.forEach((item) => {
        if (item.mesh) {
          scene.remove(item.mesh);
          if (item.mesh.geometry) item.mesh.geometry.dispose();
          if (Array.isArray(item.mesh.material)) {
            item.mesh.material.forEach(material => material.dispose());
          } else if (item.mesh.material) {
            item.mesh.material.dispose();
          }
        }
      });
      
      // Clear references
      playersRef.current.clear();
      resourceNodesRef.current = [];
      worldItemsRef.current = [];
      
      canvasRef.current?.removeChild(renderer.domElement);
      if (labelRendererRef.current) {
        canvasRef.current?.removeChild(labelRendererRef.current.domElement);
      }
      renderer.dispose();
      
      // Clear the cleanup interval
      if (cleanupIntervalRef.current) {
        clearInterval(cleanupIntervalRef.current);
      }
      
      // Remove mouse event listeners
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('wheel', handleMouseWheel);
    };
  }, [isConnected, currentZone, soundEnabled]);
  
  // Create a function to trigger manual cleanup
  const handleCleanupClick = () => {
    setIsCleaningUp(true);
    
    setTimeout(() => {
      if (cleanupFunctionsRef.current.initialCleanup) {
        cleanupFunctionsRef.current.initialCleanup();
      }
      setIsCleaningUp(false);
    }, 100);
  };
  
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      {/* Zone indicator */}
      <div style={{
        position: 'absolute',
        top: '10px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '5px 15px',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        color: 'white',
        borderRadius: '20px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        fontWeight: 'bold',
        zIndex: 100
      }}>
        {currentZone}
      </div>

      {/* Connection status indicator */}
      <div style={{
        position: 'absolute',
        top: '10px',
        left: '10px',
        display: 'flex',
        alignItems: 'center',
        padding: '5px 10px',
        backgroundColor: isConnected ? 'rgba(0, 128, 0, 0.5)' : 'rgba(255, 0, 0, 0.5)',
        color: 'white',
        borderRadius: '5px',
        fontFamily: 'sans-serif',
        fontSize: '12px',
        zIndex: 100
      }}>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: isConnected ? '#0f0' : '#f00',
          marginRight: '5px'
        }}></div>
        {isConnected ? 'Connected' : 'Disconnected'}
      </div>

      {/* Sound toggle button */}
      <button
        onClick={() => setSoundEnabled(!soundEnabled)}
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          padding: '5px 10px',
          cursor: 'pointer',
          fontSize: '12px',
          zIndex: 100
        }}
      >
        {soundEnabled ? '🔊 Sound On' : '🔇 Sound Off'}
      </button>
      
      {/* Reconnect button */}
      {!isConnected && (
        <button
          onClick={() => {
            console.log('Manual reconnect requested');
            initializeSocket().then(() => {
              console.log('Manual reconnect attempt completed');
            });
          }}
          style={{
            position: 'absolute',
            top: '40px',
            left: '10px',
            backgroundColor: 'rgba(0, 0, 255, 0.5)',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            padding: '5px 10px',
            cursor: 'pointer',
            fontSize: '12px',
            zIndex: 100
          }}
        >
          Reconnect
        </button>
      )}
      
      {/* Ghost cleanup button */}
      <button
        onClick={handleCleanupClick}
        disabled={isCleaningUp}
        style={{
          position: 'absolute',
          top: '45px',
          right: '10px',
          backgroundColor: isCleaningUp ? 'rgba(100, 100, 100, 0.5)' : 'rgba(255, 0, 0, 0.6)',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          padding: '5px 10px',
          cursor: isCleaningUp ? 'default' : 'pointer',
          fontSize: '12px',
          zIndex: 100
        }}
      >
        {isCleaningUp ? 'Cleaning...' : '👻 Remove Ghosts'}
      </button>
      
      <ChatPanel />
      <InventoryPanel />
    </div>
  );
};

export default GameCanvas; 