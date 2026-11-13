let creditsOut = false;
jest.mock('../services/claudeAI', () => ({
  OUTSOURCING_CHUNK_COUNT: 4,
  synthesizeOutsourcingReportChunk: jest.fn(async (_input: unknown, i: number) => {
    if (creditsOut && i >= 2) throw new Error('Anthropic API 400: Your credit balance is too low');
    return { markdown: `## Part ${i + 1}` };
  }),
}));
jest.mock('../services/parallelAI', () => ({ researchOutsourcingReport: jest.fn(async () => 'research') }));

import { createOutsourcingReportJob, runOutsourcingReportJob, continueOutsourcingReport, getOutsourcingReportJob } from '../services/outsourcingReportService';
import { _autoContinueQueue, dropAutoContinue } from '../services/continuation';
import { synthesizeOutsourcingReportChunk } from '../services/claudeAI';

const input = { vendorName: 'Infosys', targetIndustry: 'Banking', geoFocus: 'US', focusTech: 'Cloud', focusSegment: '' } as never;
const flush = () => new Promise((r) => setTimeout(r, 10));

it('keeps the written parts, queues for credits, and continues without repeating text', async () => {
  creditsOut = true;
  const id = createOutsourcingReportJob(input);
  await runOutsourcingReportJob(id, input);

  let job = getOutsourcingReportJob(id)!;
  expect(job.status).toBe('error');
  expect(job.canContinue).toBe(true);
  expect(job.chunksDone).toBe(2);
  expect(job.content).toBe('## Part 1\n\n## Part 2');
  expect(job.error).toMatch(/credits ran out/i);
  expect(_autoContinueQueue()).toContain(id);

  creditsOut = false;
  (synthesizeOutsourcingReportChunk as jest.Mock).mockClear();
  expect(continueOutsourcingReport(id)).toEqual({ ok: true, started: true });
  await flush();

  job = getOutsourcingReportJob(id)!;
  expect(job.status).toBe('complete');
  expect(job.canContinue).toBe(false);
  expect(job.content).toBe('## Part 1\n\n## Part 2\n\n## Part 3\n\n## Part 4');
  // Only the two missing parts were generated.
  expect((synthesizeOutsourcingReportChunk as jest.Mock).mock.calls.map((c) => c[1])).toEqual([2, 3]);
  expect(_autoContinueQueue()).not.toContain(id);
  dropAutoContinue(id);
});
