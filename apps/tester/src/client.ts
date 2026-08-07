import { ToroTask } from 'torotask';

export const client = new ToroTask({
  stepStateStore: {
    namespace: 'state',
  },
  dataStore: {
    enabled: true,
    mode: 'large',
    thresholdBytes: 2 * 1024,
    compress: 'auto',
    namespace: 'data',
  },
});
