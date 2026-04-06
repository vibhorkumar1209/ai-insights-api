import express from 'express';
import helmet from 'helmet';
import { corsMiddleware } from './middleware/cors';
import { apiLimiter } from './middleware/rateLimiter';
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

// ── Global middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(corsMiddleware);
app.use(express.json({ limit: '500kb' }));
app.use(apiLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.use('/api/competitors', competitorsRouter);
app.use('/api/benchmark', benchmarkRouter);
app.use('/api/themes', themesRouter);
app.use('/api/challenges-growth', challengesGrowthRouter);
app.use('/api/financial-analysis', financialAnalysisRouter);
app.use('/api/sales-play', salesPlayRouter);
app.use('/api/key-buyers', keyBuyersRouter);
app.use('/api/industry-trends', industryTrendsRouter);
app.use('/api/industry-report', industryReportRouter);
app.use('/api/business-description', businessDescriptionRouter);
app.use('/api/niche-industries', nicheIndustryRouter);
app.use('/api/marketing-strategy', marketingStrategyRouter);

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
