import { DelayedError, WaitingChildrenError } from 'bullmq';
import type { Logger } from 'pino';
import * as z from 'zod';
import { BaseTask } from './base-task.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type {
  EffectivePayloadType,
  ResolvedSchemaType,
  SubTaskHandler,
  TaskConfig,
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerOptions,
  TaskOptions,
  TaskJobData,
  SchemaHandler,
} from './types/index.js';
// Import new/updated utility types
import { TaskJob } from './job.js';
import { StepExecutor } from './step-executor.js';

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseTask to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template PayloadExplicit The explicitly provided payload type. Defaults to `unknown`.
 *                           If not `unknown`, this type takes precedence.
 *                           If `unknown`, type is inferred from `Schema` or defaults to `any`.
 * @template ResultType The expected return type of the job. Defaults to `unknown`.
 * @template SchemaInputVal The input schema type for payload validation and type inference. Defaults to `undefined`.
 */
export class Task<
  PayloadExplicit = unknown, // Default changed to unknown
  ResultType = unknown,
  SchemaInputVal extends SchemaHandler = undefined, // Task is generic over INPUT schema type
  ActualPayloadType extends EffectivePayloadType<
    PayloadExplicit,
    ResolvedSchemaType<SchemaInputVal>
  > = EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInputVal>>,
> extends BaseTask<
  ActualPayloadType,
  ResultType,
  string, // NameType for BaseTask
  TaskJobData<ActualPayloadType>, // DataType for BaseTask
  TaskOptions // TOptions for BaseTask
> {
  /**
   * A type-only property to help infer the actual payload type of the task.
   * This is equivalent to EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInputVal>>.
   */
  public readonly _payloadType!: ActualPayloadType;

  protected readonly subTasks: Map<string, SubTask<any, any>>; // SubTask payload/result types might need further consideration for inference
  protected readonly allowCatchAll: boolean;
  // The handler's payload type is determined by EffectivePayloadType.
  // TaskHandler (imported) uses EffectivePayloadType from types/task.ts.
  // The local EffectivePayloadType must match for consistency.
  protected handler: TaskHandler<ActualPayloadType, ResultType, ResolvedSchemaType<SchemaInputVal>>;
  public readonly schema: ResolvedSchemaType<SchemaInputVal>; // Stores the RESOLVED schema instance or undefined

  constructor(
    taskGroup: TaskGroup,
    id: string,
    // config's PayloadExplicit defaults to unknown, ResultType to unknown, SchemaInputVal to undefined
    // TaskDefinition itself uses EffectivePayloadType internally for its handler and triggers.
    config: TaskConfig<PayloadExplicit, ResultType, SchemaInputVal>,
    groupLogger: Logger
  ) {
    // Pass the effective payload type to BaseTask's triggers if necessary,
    // currently TaskDefinition handles the trigger's payload type.
    super(taskGroup, id, config.options ?? {}, config.triggers, groupLogger);

    this.handler = config.handler;

    // config.schema is now directly SchemaInputVal (which is ZodSchema | undefined)
    // ResolvedSchemaType<SchemaInputVal> will correctly resolve this.
    // So, this.schema (which is ResolvedSchemaType<SchemaInputVal>) can be directly assigned.
    this.schema = config.schema as ResolvedSchemaType<SchemaInputVal>;

    this.subTasks = new Map();
    this.allowCatchAll = this.options.allowCatchAll ?? true;

    this.logger.debug(
      {
        allowCatchAll: this.allowCatchAll,
        triggerCount: this.triggers?.length ?? 0, // Access triggers from config or this.triggers if super sets it
        hasPayloadSchema: !!this.schema,
      },
      'Task initialized'
    );
  }

  defineSubTask<
    SubTaskPayloadType = ActualPayloadType, // Default SubTask payload to parent's effective type
    SubTaskResultType = ResultType,
  >(
    subTaskId: string,
    subTaskHandler: SubTaskHandler<SubTaskPayloadType, SubTaskResultType>
  ): SubTask<SubTaskPayloadType, SubTaskResultType> {
    if (this.subTasks.has(subTaskId)) {
      this.logger.warn({ subTaskId }, 'SubTask already defined. Overwriting.');
    }
    if (subTaskId === this.id) {
      this.logger.error({ subTaskId }, 'SubTask id cannot be the same as the parent Task id.');
      throw new Error(`SubTask id "${subTaskId}" cannot be the same as the parent Task id "${this.id}".`);
    }

    // SubTask's payload type defaults to the parent's effective payload type
    const newSubTask = new SubTask<SubTaskPayloadType, SubTaskResultType>(this as any, subTaskId, subTaskHandler);
    this.subTasks.set(subTaskId, newSubTask);
    this.logger.debug({ subTaskId }, 'SubTask defined');
    return newSubTask;
  }

  getSubTask(subTaskId: string): SubTask<any, any> | undefined {
    return this.subTasks.get(subTaskId);
  }

  async process(job: TaskJob<ActualPayloadType, ResultType>, token?: string): Promise<any> {
    const { id, name: jobName } = job;
    const effectiveJobName = jobName === '' || jobName === '__default__' ? this.id : jobName;
    const jobLogger = this.logger.child({ jobId: id, jobName: effectiveJobName });

    const subTask = this.subTasks.get(effectiveJobName);

    try {
      if (subTask) {
        jobLogger.info(`Routing job to SubTask handler: ${effectiveJobName}`);
        // SubTask processing might also need payload validation if schemas are defined there
        // For now, assumes subtask handles its own payload typing/validation if necessary
        const result = await subTask.processSubJob(job as any, effectiveJobName, jobLogger); // Cast job if subtask has different payload type
        jobLogger.info(`SubTask job completed successfully`);
        return result;
      } else if (effectiveJobName === this.id || this.allowCatchAll) {
        // Pass jobLogger to processJob
        const result = await this.processJob(job, token, jobLogger);
        jobLogger.debug(`Main task job completed successfully`);
        return result;
      } else {
        jobLogger.error(
          `Job name "${effectiveJobName}" does not match main task or subtasks, and catchAll is disabled.`
        );
        throw new Error(
          `Job name "${effectiveJobName}" on queue "${this.queueName}" not recognized by task "${this.id}".`
        );
      }
    } catch (error: any) {
      if (
        error instanceof DelayedError ||
        error.name == 'DelayedError' ||
        error instanceof WaitingChildrenError ||
        error.name == 'WaitingChildrenError'
      ) {
        // These are BullMQ flow control errors, re-throw or handle as per BullMQ docs
        // Depending on BullMQ version, returning undefined might be the correct way to let BullMQ handle it.
        jobLogger.debug({ err: error }, `Job processing resulted in a flow control state: ${error.name}`);
        return; // Or re-throw error;
      }

      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${effectiveJobName}"`
      );
      throw error;
    }
  }

  async processJob(job: TaskJob<ActualPayloadType, ResultType>, token?: string, jobLogger?: Logger): Promise<any> {
    const effectiveJobLogger = jobLogger ?? this.getJobLogger(job);
    // Use CurrentPayloadType which is derived from the local EffectivePayloadType
    type CurrentPayloadType = ActualPayloadType;

    let validatedPayload: CurrentPayloadType = job.payload;

    if (this.schema) {
      try {
        // Type assertion needed because this.schema is Schema (ZodSchema | undefined)
        // and parse expects `this` to be ZodSchema<CurrentPayloadType>
        validatedPayload = (this.schema as z.ZodSchema<CurrentPayloadType>).parse(job.payload);
        effectiveJobLogger.debug('Payload validated successfully.');
      } catch (error) {
        effectiveJobLogger.error(
          {
            err: error instanceof z.ZodError ? error.format() : error,
            originalPayload: job.payload,
          },
          `Payload validation failed for job "${job.name}" (id: ${job.id})`
        );
        if (error instanceof z.ZodError) {
          const messages = error.errors.map((e) => `${e.path.join('.') || 'payload'}: ${e.message}`);
          throw new Error(`Payload validation failed: ${messages.join('; ')}`);
        }
        throw error;
      }
    }

    const handlerOptions: TaskHandlerOptions<CurrentPayloadType> = {
      id: job.id,
      name: this.id,
      payload: validatedPayload,
    };

    const stepExecutor = new StepExecutor<TaskJob<CurrentPayloadType, ResultType>>(job);
    // TaskHandlerContext's PayloadType will be CurrentPayloadType
    const handlerContext: TaskHandlerContext<CurrentPayloadType, ResultType, ResolvedSchemaType<SchemaInputVal>> = {
      logger: effectiveJobLogger,
      client: this.taskClient,
      group: this.group,
      task: this as any, // `this` is Task<PayloadExplicit, ResultType, SchemaInputVal>
      // Context expects Task<CurrentPayloadType, ResultType, SchemaInputVal>
      // This cast is generally safe due to how CurrentPayloadType is derived.
      job: job,
      step: stepExecutor,
      token,
      queue: this.queue,
    };
    try {
      // this.handler's PayloadType is also CurrentPayloadType due to consistent EffectivePayloadType usage
      return await this.handler(handlerOptions, handlerContext);
    } catch (error) {
      effectiveJobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job handler execution failed for job "${job.name}" (id: ${job.id})`
      );
      throw error;
    }
  }
}
