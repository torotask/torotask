import type { RepeatOptions } from 'bullmq';

// Interface for the data stored in the event set
export interface EventSubscriptionInfo {
  taskGroup: string;
  taskId: string;
  triggerId?: number;
  eventId?: string;
  data?: Record<string, any>;
}

export type RepeatOptionsWithoutKey = Omit<RepeatOptions, 'key'>;

// Return value for the EventManager sync job
export interface SyncJobReturn {
  registered: number;
  unregistered: number;
  errors: number;
}

export interface SyncJobPayload {
  taskGroup: string;
  taskId: string;
  // The complete list of event subscriptions this task *should* have
  desiredSubscriptions: EventSubscriptionInfo[];
}
