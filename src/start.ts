import dotenv from 'dotenv';

// Load environment variables from .env file FIRST, before anything else
const result = dotenv.config();

// Manually assign parsed variables to ensure they're available
if (result.parsed) {
  Object.entries(result.parsed).forEach(([key, value]) => {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

// Then start the app
// We need to dynamically import the app since require.main won't be true when imported
(async () => {
  try {
    const appModule = await import('./app');
    const app = appModule.default;
    const PORT = parseInt(process.env.PORT || '4000', 10);
    app.listen(PORT, () => {
      console.log(`AI Insights API running on port ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('Failed to start app:', err);
    process.exit(1);
  }
})();
