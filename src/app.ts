import dotenv from 'dotenv';
dotenv.config();

import express, { Express } from 'express';
import helmet from 'helmet';
import { corsMiddleware } from './middleware/cors';
import { apiLimiter, memoryGuard } from './middleware/rateLimiter';
import competitorsRouter from './routes/competitors';
import benchmarkRouter from './routes/benchmark';
import themesRouter from './routes/themes';
import challengesGrowthRouter from './routes/challengesGrowth';
import financialAnalysisRouter from './routes/financialAnalysis';
import salesPlayRouter from './routes/salesPlay';
import salesPlay2Router from './routes/salesPlay2';
import objectionHandlingRouter from './routes/objectionHandling';
import keyBuyersRouter from './routes/keyBuyers';
import industryTrendsRouter from './routes/industryTrends';
import industryReportRouter from './routes/industryReport';
import businessDescriptionRouter from './routes/businessDescription';
import nicheIndustryRouter from './routes/nicheIndustry';
import marketingStrategyRouter from './routes/marketingStrategy';
import personaRouter from './routes/persona';
import businessSegmentsRouter from './routes/businessSegments';
import businessTimelinesRouter from './routes/businessTimelines';
import technologyHeatMapRouter from './routes/technologyHeatMap';
import contentGenerationRouter from './routes/contentGeneration';
import consultingIntelligenceRouter from './routes/consultingIntelligence';
import vucaAnalysisRouter from './routes/vucaAnalysis';
import firmographicRouter from './routes/firmographic';
import outsourcingReportRouter from './routes/outsourcingReport';
import gccSalesPlayRouter from './routes/gccSalesPlay';

const app: Express = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

// Trust Render/Vercel reverse proxy so express-rate-limit reads the real client IP
app.set('trust proxy', 1);

// ── Keep process alive — log but never exit on unhandled errors ───────────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] caught — keeping process alive:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] caught — keeping process alive:', reason);
});

// ── Global middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(corsMiddleware);
app.use(express.json({ limit: '500kb' }));
app.use(apiLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.use('/api/competitors', memoryGuard, competitorsRouter);
app.use('/api/benchmark', memoryGuard, benchmarkRouter);
app.use('/api/themes', memoryGuard, themesRouter);
app.use('/api/challenges-growth', memoryGuard, challengesGrowthRouter);
app.use('/api/financial-analysis', memoryGuard, financialAnalysisRouter);
app.use('/api/sales-play', memoryGuard, salesPlayRouter);
app.use('/api/sales-play-2', memoryGuard, salesPlay2Router);
app.use('/api/key-buyers', memoryGuard, keyBuyersRouter);
app.use('/api/industry-trends', memoryGuard, industryTrendsRouter);
app.use('/api/industry-report', memoryGuard, industryReportRouter);
app.use('/api/business-description', memoryGuard, businessDescriptionRouter);
app.use('/api/niche-industries', memoryGuard, nicheIndustryRouter);
app.use('/api/marketing-strategy', memoryGuard, marketingStrategyRouter);
app.use('/api/persona', memoryGuard, personaRouter);
app.use('/api/business-segments', memoryGuard, businessSegmentsRouter);
app.use('/api/business-timelines', memoryGuard, businessTimelinesRouter);
app.use('/api/technology-heat-map', memoryGuard, technologyHeatMapRouter);
app.use('/api/content-generation', memoryGuard, contentGenerationRouter);
app.use('/api/consulting-intelligence', memoryGuard, consultingIntelligenceRouter);
app.use('/api/vuca-analysis', memoryGuard, vucaAnalysisRouter);
app.use('/api/objection-handling', memoryGuard, objectionHandlingRouter);
app.use('/api/firmographic', memoryGuard, firmographicRouter);
app.use('/api/industry-outsourcing-report', memoryGuard, outsourcingReportRouter);
app.use('/api/gcc-sales-play', memoryGuard, gccSalesPlayRouter);

// ── Debug: test Claude connectivity ──────────────────────────────────────────
app.get('/api/debug-claude', async (_req, res) => {
  const start = Date.now();
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with: {"ok":true}' }],
    });
    const text = resp.content[0].type === 'text' ? resp.content[0].text : '(no text)';
    res.json({ ok: true, ms: Date.now() - start, text, apiKeySet: !!process.env.ANTHROPIC_API_KEY });
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - start, error: String(e), apiKeySet: !!process.env.ANTHROPIC_API_KEY });
  }
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ─────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Insights API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

export default app;
