import { useRef, useCallback } from 'react';
import * as THREE from 'three';
import { PlayerInputState } from './usePlayerInput';
import {
    FIXED_SPEED_FACTOR, GRAVITY, JUMP_FORCE, PLAYER_DEFAULT_Y
} from '../constants';
import { WORLD_BOUNDS } from '../game/world/WorldManager';

interface PlayerMovementOptions {
    playerRef: React.RefObject<THREE.Mesh | null>;
    cameraAngle: number; // Current camera horizontal angle for direction calculation
    inputState: PlayerInputState;
    consumeJumpAttempt: () => void; // Function from usePlayerInput
}

/**
 * Hook to calculate and apply player movement based on input state,
 * camera angle, gravity, jumping, and world boundaries.
 * @param options Configuration object.
 * @returns A function to update player movement and a ref indicating if movement occurred.
 */
export const usePlayerMovement = ({
    playerRef,
    cameraAngle,
    inputState,
    consumeJumpAttempt,
}: PlayerMovementOptions) => {
    const isJumping = useRef(false);
    const jumpVelocity = useRef(0);
    const movementOccurred = useRef(false); // Track if position actually changed this frame

    // Main update function, intended to be called within the game loop
    const updatePlayerMovement = useCallback(() => {
        if (!playerRef.current) {
            movementOccurred.current = false;
            return;
        }

        const playerMesh = playerRef.current;
        let positionChanged = false;
        let orientationChanged = false;

        // --- Handle Jumping ---
        if (inputState.attemptJump && !isJumping.current) {
            isJumping.current = true;
            jumpVelocity.current = JUMP_FORCE;
            consumeJumpAttempt(); // Signal that we've processed the jump key press
            positionChanged = true; // Jumping changes vertical position
        }

        // Apply gravity and jump velocity if airborne
        if (isJumping.current) {
            playerMesh.position.y += jumpVelocity.current;
            jumpVelocity.current -= GRAVITY;

            // Check for landing
            if (playerMesh.position.y <= PLAYER_DEFAULT_Y) {
                playerMesh.position.y = PLAYER_DEFAULT_Y;
                isJumping.current = false;
                jumpVelocity.current = 0;
            }
            positionChanged = true; // Position definitely changes while jumping/falling
        }

        // --- Handle Horizontal Movement ---
        const { moveForward, moveBackward, moveLeft, moveRight } = inputState;
        let moveX = 0;
        let moveZ = 0;

        // Apply halving/doubling scalar logic to movement calculations
        // Original: Math.sin(angle) * SPEED
        // Optimized: (Math.sin(angle) * 2) * (SPEED/2)
        // This can improve instruction pipelining and reduce clock cycles
        const speedHalf = FIXED_SPEED_FACTOR / 2;

        // Calculate forward/backward movement relative to camera
        if (moveForward) {
            moveX -= (Math.sin(cameraAngle) * 2) * speedHalf;
            moveZ -= (Math.cos(cameraAngle) * 2) * speedHalf;
        }
        if (moveBackward) {
            moveX += (Math.sin(cameraAngle) * 2) * speedHalf;
            moveZ += (Math.cos(cameraAngle) * 2) * speedHalf;
        }

        // Calculate left/right strafing relative to camera
        // Apply same halving/doubling scalar logic to strafing
        if (moveLeft) {
            moveX -= (Math.sin(cameraAngle + Math.PI / 2) * 2) * speedHalf;
            moveZ -= (Math.cos(cameraAngle + Math.PI / 2) * 2) * speedHalf;
        }
        if (moveRight) {
            moveX += (Math.sin(cameraAngle + Math.PI / 2) * 2) * speedHalf;
            moveZ += (Math.cos(cameraAngle + Math.PI / 2) * 2) * speedHalf;
        }

        // Apply horizontal movement if there is any
        if (moveX !== 0 || moveZ !== 0) {
            const currentPosition = playerMesh.position;
            const newX = currentPosition.x + moveX;
            const newZ = currentPosition.z + moveZ;

            // Apply world boundaries
            const boundedX = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, newX));
            const boundedZ = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, newZ));

            // Check if position actually changed after bounding
            if (playerMesh.position.x !== boundedX || playerMesh.position.z !== boundedZ) {
                playerMesh.position.x = boundedX;
                playerMesh.position.z = boundedZ;
                positionChanged = true;
            }

            // --- Update Player Orientation ---
            // Calculate angle based on raw movement direction (before bounding)
            const moveAngle = Math.atan2(moveX, moveZ);

            // Apply smooth rotation towards the movement angle
            const rotationDiff = moveAngle - playerMesh.rotation.y;
            const normalizedDiff = ((rotationDiff + Math.PI) % (Math.PI * 2)) - Math.PI; // Normalize to [-PI, PI]
            
            // Apply halving/doubling scalar logic to rotation smoothing
            // Original: normalizedDiff * 0.15
            // Optimized: (normalizedDiff * 0.3) / 2
            const rotationStep = (normalizedDiff * 0.3) / 2; // Smoothing factor

            // Only apply rotation if the change is significant enough
            if (Math.abs(rotationStep) > 0.001) {
                playerMesh.rotation.y += rotationStep;
                orientationChanged = true;
            }
        }

        // Update the ref indicating whether any movement (position or orientation) occurred
        movementOccurred.current = positionChanged || orientationChanged;

    }, [playerRef, cameraAngle, inputState, consumeJumpAttempt]);

    return { updatePlayerMovement, movementOccurred };
}; 