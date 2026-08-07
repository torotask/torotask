import type { FormatterField, JobStatus } from '@bull-board/api/typings/app';
import type { Job, Queue } from 'bullmq';
import type { StepResult, TaskJobData, TaskJobState, ToroTask, ToroTaskDataRef } from 'torotask';
import type { ToroTaskBullMQAdapterOptions } from './adapter-options.js';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { isToroTaskDataRef } from 'torotask';
import { createTruncateFormatter } from './truncate-formatter.js';

interface EnrichJobOptions {
  /** When true, load full values from the ToroTask data store (job detail view). */
  resolveDataRefs: boolean;
  /** When false, skip loading external step state (faster job list). */
  includeStepState: boolean;
}

function formatRefLabel(ref: ToroTaskDataRef): string {
  const sizeLabel
    = ref.byteLength >= 1024
      ? `${(ref.byteLength / 1024).toFixed(1)} KiB`
      : `${ref.byteLength} B`;

  return `[ToroTask external data] ${sizeLabel}${ref.compressed ? ', compressed' : ''} — open job to load`;
}

function formatRefSummary(ref: ToroTaskDataRef): ToroTaskDataRef & { _display: string } {
  return {
    ...ref,
    _display: formatRefLabel(ref),
  };
}

/** Adds `_display` hints on nested data refs without loading blobs. */
function annotateDataRefs(value: unknown): unknown {
  if (isToroTaskDataRef(value)) {
    return formatRefSummary(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => annotateDataRefs(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        annotateDataRefs(item),
      ]),
    );
  }

  return value;
}

function formatReturnValueForBoard(value: unknown): unknown {
  if (isToroTaskDataRef(value)) {
    return formatRefLabel(value);
  }

  return annotateDataRefs(value);
}

function formatJobDataForBoard(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const record = { ...(value as Record<string, unknown>) };

  if (isToroTaskDataRef(record.payload)) {
    const payloadRef = record.payload;
    record.payload = formatRefSummary(payloadRef);
    record._torotaskPayloadRef = formatRefLabel(payloadRef);
  }
  else if (record.payload !== undefined) {
    record.payload = annotateDataRefs(record.payload);
  }

  if (record.state !== undefined) {
    record.state = annotateDataRefs(record.state);
  }

  return record;
}

const builtInDataRefFormatters = {
  returnValue: formatReturnValueForBoard,
  data: formatJobDataForBoard,
} as const;

export { annotateDataRefs, formatJobDataForBoard, formatRefLabel, formatReturnValueForBoard };

/**
 * Bull Board adapter that merges external step state into job.data for display.
 * ToroTask stores step state outside BullMQ job.data; this restores visibility in the UI.
 *
 * Job list responses keep compact data refs; opening a job resolves them from the data store.
 */
export class ToroTaskBullMQAdapter extends BullMQAdapter {
  private readonly queueName: string;
  private readonly customFormatters = new Map<string, (value: unknown) => unknown>();

  constructor(
    private readonly taskClient: ToroTask,
    queue: Queue,
    options?: ToroTaskBullMQAdapterOptions,
  ) {
    const { truncate, ...boardOptions } = options ?? {};
    super(queue, boardOptions);
    this.queueName = queue.name;
    this.installDataRefFormatters();

    if (truncate) {
      const truncateFormatter = createTruncateFormatter(truncate);
      this.setFormatter('data', truncateFormatter);
      this.setFormatter('returnValue', truncateFormatter);
    }
  }

  /**
   * Chains custom formatters after ToroTask data-ref formatting so consumers
   * (e.g. truncation helpers) cannot accidentally replace ref labels.
   */
  override setFormatter(field: FormatterField, formatter: (value: unknown) => unknown): void {
    this.customFormatters.set(field, formatter);
    if (field in builtInDataRefFormatters) {
      this.installDataRefFormatters();
    }
    else {
      super.setFormatter(field, formatter);
    }
  }

  private installDataRefFormatters(): void {
    for (const field of Object.keys(builtInDataRefFormatters) as Array<keyof typeof builtInDataRefFormatters>) {
      super.setFormatter(field, value => this.applyDataRefFormatters(field, value));
    }
  }

  private applyDataRefFormatters(field: keyof typeof builtInDataRefFormatters, value: unknown): unknown {
    let formatted = builtInDataRefFormatters[field](value);
    const custom = this.customFormatters.get(field);
    if (custom) {
      formatted = custom(formatted);
    }
    return formatted;
  }

  override async getJob(id: string): Promise<Job | undefined> {
    const job = await super.getJob(id);
    if (!job) {
      return job;
    }
    return this.enrichJob(job, { resolveDataRefs: true, includeStepState: true });
  }

  override async getJobs(
    jobStatuses: JobStatus[],
    start?: number,
    end?: number,
  ): Promise<Job[]> {
    const jobs = await super.getJobs(jobStatuses, start, end);
    return Promise.all(
      jobs.map(job => this.enrichJob(job, { resolveDataRefs: false, includeStepState: false })),
    );
  }

  private async enrichJob(job: Job, options: EnrichJobOptions): Promise<Job> {
    if (!job?.data || !job.id) {
      return job;
    }

    const data = job.data as TaskJobData;
    const dataStore = this.taskClient.getDataStore?.();

    if (options.resolveDataRefs && dataStore) {
      if (data.payload !== undefined) {
        data.payload = await dataStore.resolveDeep(data.payload);
      }
      if (job.returnvalue !== undefined) {
        job.returnvalue = await dataStore.resolveDeep(job.returnvalue);
      }
    }

    let stepState: Record<string, StepResult> = {};
    if (options.includeStepState) {
      stepState = await this.taskClient.getStepStateStore().loadSteps(
        this.queueName,
        job.id,
      );

      if (options.resolveDataRefs && dataStore) {
        for (const [stepId, result] of Object.entries(stepState) as Array<[string, StepResult]>) {
          if (result.data !== undefined) {
            result.data = await dataStore.resolveDeep(result.data);
          }
          stepState[stepId] = result;
        }
      }
    }

    if (Object.keys(stepState).length === 0) {
      if (!options.resolveDataRefs || !dataStore) {
        return job;
      }

      job.data = { ...data };
      return job;
    }

    job.data = {
      ...data,
      state: {
        ...(data.state ?? {}),
        stepState,
      } as TaskJobState,
    };

    return job;
  }
}
