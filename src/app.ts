import express from 'express';
import helmet from 'helmet';
import { corsMiddleware } from './middleware/cors';
import { apiLimiter, memoryGuard } from './middleware/rateLimiter';
import competitorsRouter from './routes/competitors';
import benchmarkRouter from './routes/benchmark';
import themesRouter from './routes/themes';
import challengesGrowthRouter from './routes/challengesGrowth';
import financialAnalysisRouter from './routes/financialAnalysis';
import salesPlayRouter from './routes/salesPlay';
import keyBuyersRouter from './routes/keyBuyers';
import industryTrendsRouter from './routes/industryTrends';
import industryReportRouter from './routes/industryReport';
import businessDescriptionRouter from './routes/businessDescription';
import nicheIndustryRouter from './routes/nicheIndustry';
import marketingStrategyRouter from './routes/marketingStrategy';

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

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
app.use('/api/key-buyers', memoryGuard, keyBuyersRouter);
app.use('/api/industry-trends', memoryGuard, industryTrendsRouter);
app.use('/api/industry-report', memoryGuard, industryReportRouter);
app.use('/api/business-description', memoryGuard, businessDescriptionRouter);
app.use('/api/niche-industries', memoryGuard, nicheIndustryRouter);
app.use('/api/marketing-strategy', memoryGuard, marketingStrategyRouter);

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
