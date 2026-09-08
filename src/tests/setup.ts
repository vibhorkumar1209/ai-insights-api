// The memory guard's production threshold (250MB, sized for Render's 512MB
// instance) measures the *process* heap. Under Jest that is the test runner's
// heap, which routinely exceeds 250MB, so without this every route test would
// get a 503 from the guard before reaching its handler.
process.env.MEMORY_GUARD_MAX_HEAP_MB = '100000';
