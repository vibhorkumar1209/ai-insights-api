/**
 * Centralized error handling for async job routes.
 * Updates job status and notifies all subscribed SSE clients of the failure.
 *
 * This is a generic utility that works with any job type since different
 * job types have different status unions (IndustryReportResult, FinancialAnalysisResult, etc.)
 */

export interface JobManager {
  updateJob(jobId: string, updates: Record<string, unknown>): void | unknown;
  emit(jobId: string, event: string, data: unknown): void;
  getJob(jobId: string): unknown;
}

/**
 * Handle and propagate job errors to clients via SSE.
 * Called from route catch handlers as a safety net.
 * @param jobId - The job ID that failed
 * @param error - The error that occurred
 * @param manager - Object with updateJob, emit, getJob methods (from the service)
 */
export function handleJobError(
  jobId: string,
  error: unknown,
  manager: JobManager
): void {
  const errorMsg = error instanceof Error ? error.message : String(error);

  // Update job status to error
  manager.updateJob(jobId, {
    status: 'error',
    error: errorMsg,
    progress: 0  // Reset progress on error
  });

  // Notify all subscribed SSE clients of the error
  const job = manager.getJob(jobId);
  if (job) {
    manager.emit(jobId, 'error', { error: errorMsg });
  }

  // Also log for debugging
  console.error(`[jobErrorHandler] Job ${jobId} error handled:`, errorMsg);
}
