// Progress event bus for cross-component order progress communication
// Used to sync progress between OrderDetailsModal and Orders list

export interface ProgressUpdateEvent {
  orderId: string;
  progressData: {
    totalTests: number;
    pendingVerification: number;
    verifiedTests: number;
    completedTests: number;
    progressPercentage: number;
  };
}

// Event types
export const PROGRESS_EVENTS = {
  UPDATE: 'order-progress-update',
} as const;

// Publish progress update event
export const publishProgressUpdate = (orderId: string, progressData: ProgressUpdateEvent['progressData']) => {
  const event = new CustomEvent(PROGRESS_EVENTS.UPDATE, {
    detail: { orderId, progressData }
  });
  window.dispatchEvent(event);
};

// Subscribe to progress update events
export const subscribeToProgressUpdates = (callback: (event: ProgressUpdateEvent) => void) => {
  const handleEvent = (event: CustomEvent) => {
    callback(event.detail);
  };
  
  window.addEventListener(PROGRESS_EVENTS.UPDATE, handleEvent as EventListener);
  
  // Return unsubscribe function
  return () => {
    window.removeEventListener(PROGRESS_EVENTS.UPDATE, handleEvent as EventListener);
  };
};