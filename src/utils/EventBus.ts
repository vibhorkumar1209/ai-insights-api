/**
 * Generic pub/sub EventBus for broadcasting events to SSE subscribers.
 * Handles subscriptions, unsubscriptions, and event publishing.
 */

export type EventCallback = (event: string, data: unknown) => void;

export class EventBus {
  private subscribers = new Map<string, EventCallback[]>();

  /**
   * Subscribe to events for a specific resource (e.g., jobId)
   */
  subscribe(resourceId: string, callback: EventCallback): void {
    const list = this.subscribers.get(resourceId) || [];
    list.push(callback);
    this.subscribers.set(resourceId, list);
  }

  /**
   * Unsubscribe a callback from a resource
   */
  unsubscribe(resourceId: string, callback: EventCallback): void {
    const list = (this.subscribers.get(resourceId) || []).filter(
      (fn) => fn !== callback
    );
    if (list.length > 0) {
      this.subscribers.set(resourceId, list);
    } else {
      this.subscribers.delete(resourceId);
    }
  }

  /**
   * Emit an event to all subscribers of a resource
   */
  emit(resourceId: string, event: string, data: unknown): void {
    const callbacks = this.subscribers.get(resourceId) || [];
    callbacks.forEach((callback) => {
      try {
        callback(event, data);
      } catch (err) {
        // Ignore callback errors (e.g., closed connections)
        console.debug(
          `[EventBus] Error in callback for ${resourceId}/${event}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    });
  }

  /**
   * Get subscriber count for a resource
   */
  getSubscriberCount(resourceId: string): number {
    return (this.subscribers.get(resourceId) || []).length;
  }

  /**
   * Check if a resource has subscribers
   */
  hasSubscribers(resourceId: string): boolean {
    return this.getSubscriberCount(resourceId) > 0;
  }

  /**
   * Clear all subscribers for a resource
   */
  clearSubscribers(resourceId: string): void {
    this.subscribers.delete(resourceId);
  }

  /**
   * Clear all subscribers (for testing or shutdown)
   */
  clearAll(): void {
    this.subscribers.clear();
  }

  /**
   * Get total subscriber count across all resources
   */
  getTotalSubscriberCount(): number {
    let total = 0;
    for (const callbacks of this.subscribers.values()) {
      total += callbacks.length;
    }
    return total;
  }
}

// Singleton instance for shared use
let eventBusInstance: EventBus | null = null;

/**
 * Get or create the global EventBus singleton
 */
export function getEventBus(): EventBus {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus();
  }
  return eventBusInstance;
}

/**
 * Reset the singleton (mainly for testing)
 */
export function resetEventBus(): void {
  if (eventBusInstance) {
    eventBusInstance.clearAll();
  }
  eventBusInstance = null;
}
