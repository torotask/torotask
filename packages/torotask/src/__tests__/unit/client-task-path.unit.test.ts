import { ToroTask } from '../../client.js';

function createClientWithMethod(method: '_getTask' | '_runTask', implementation: jest.Mock): ToroTask {
  const client = Object.create(ToroTask.prototype) as ToroTask;
  Object.defineProperty(client, method, { value: implementation });
  return client;
}

describe('dotted task paths', () => {
  it('retains the complete dotted task id when looking up a task', () => {
    const expectedTask = { id: 'email.transactional.send' };
    const getTask = jest.fn().mockReturnValue(expectedTask);
    const client = createClientWithMethod('_getTask', getTask);

    expect(client.getTaskByPath('messages.email.transactional.send')).toBe(expectedTask);
    expect(getTask).toHaveBeenCalledWith('messages', 'email.transactional.send');
  });

  it('retains the complete dotted task id when running a task', async () => {
    const expectedJob = { id: 'job-id' };
    const runTask = jest.fn().mockResolvedValue(expectedJob);
    const client = createClientWithMethod('_runTask', runTask);
    const payload = { message: 'hello' };

    await expect(client.runTaskByPath('messages.email.transactional.send', payload)).resolves.toBe(expectedJob);
    expect(runTask).toHaveBeenCalledWith('messages', 'email.transactional.send', payload);
  });
});
