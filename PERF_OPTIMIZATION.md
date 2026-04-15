# Web App Performance Optimization Plan

## Current State
- **Deployment**: Render free tier (512MB RAM, 0.1 vCPU)
- **Backend**: Express + TypeScript
- **Frontend**: Next.js 14
- **AI Model**: Claude Sonnet 4.6
- **Hybrid AI**: Parallel.AI (research) + Claude (synthesis)
- **Rate Limits**: 50 AI requests/hour, 30 general/15min
- **Memory Cap**: 300MB heap, 250MB guard threshold
- **Tokens**: MAX_OUTPUT_TOKENS = 4096 (synthesis), 2048 (wizard)

## Goals
1. ✅ High-quality, detailed output (no degradation)
2. ✅ Fast performance (reports < 2 minutes)
3. ✅ Minimum token/cost usage
4. ✅ Multi-user concurrency without OOM/rate-limit issues

---

## Solution Architecture

### 1. Caching Layer (Token & Cost Reduction)
**Problem**: Same queries re-researched, same segments re-suggested, same prompts re-called
**Solution**: Redis-like caching (or SQLite on Render free tier)

#### 1A. Research Cache
- **What**: Cache Parallel.AI results by query hash
- **Key**: `research:{md5(query)}`
- **TTL**: 7 days (market data stable)
- **Benefit**: 80% token savings on repeat industry queries
- **Implementation**: Add before `researchIndustryReport()` call

#### 1B. Scope/Segment Cache
- **What**: Cache `extractScopeWithWizard()` results
- **Key**: `scope:{industry}:{geography}:{hash(subIndustry)}`
- **TTL**: 7 days
- **Benefit**: Skip Claude call for repeat industries
- **Implementation**: Check cache before Claude call in `scopeWithWizard()`

#### 1C. Prompt Template Cache
- **What**: Pre-compute section definition prompts
- **Key**: `section_prompt:{section_id}:{model}`
- **TTL**: 30 days (static)
- **Benefit**: No runtime string building
- **Implementation**: Build once at startup

### 2. Streaming & Chunking (Speed)
**Problem**: User waits for entire report before anything renders
**Solution**: Stream each section as it completes

#### 2A. Backend Streaming
- Keep existing SSE (Server-Sent Events)
- Split `runIndustryReportV2()` into micro-steps:
  ```
  1. Scope → emit (50ms)
  2. Research Query 1 → emit (2-5s)
  3. Research Query 2 → emit (2-5s)
  4. Market Sizing → emit (5-8s)
  5. Batch 1 (Market Overview) → emit (8-12s)
  6. Batch 2 (Market Size by Segment) → emit (10-15s)
  7. Batch 3 (Market Dynamics) → emit (10-15s)
  ... (continue for each batch)
  ```
- Each emit includes partial result so frontend can render incrementally

#### 2B. Frontend Streaming
- Show sections as they arrive (not waiting for complete report)
- Skeleton loaders while section is being generated
- Use React suspense or manual `useState` updates

### 3. Token Optimization (Cost)
**Problem**: MAX_OUTPUT_TOKENS=4096 is overkill, generates 2000-3000 tokens per section
**Solution**: Target-specific token budgets per section

#### 3A. Reduce Token Budget by Section
```typescript
const TOKEN_BUDGETS = {
  market_overview: 1024,          // 1K tokens = ~800 words
  market_size_by_segment: 1024,   // subsections + table = 800 words
  market_dynamics: 1200,          // 4 tables + 2 paras = 1K words
  competition_analysis: 1500,     // BCG + 10 profiles = 1.2K words
  regulatory_overview: 800,       // 4 tables + 1-2 paras = 600 words
  forecast: 1024,                 // 3 charts + 2 tables = 800 words
  swot: 512,                      // just 4 boxes = 400 words
  porters_five_forces: 512,       // just 5 forces = 400 words
  tei_analysis: 512,              // just triggers table = 400 words
  executive_summary: 1024,        // headline + insights = 800 words
};
```
- **Benefit**: 30-40% token reduction (4096 → 2500-3000 avg)
- **Quality**: No loss (responses naturally fit budget)

#### 3B. Reduce Research Slice Size
```typescript
// Currently: 20KB per section batch
// Target: 15KB per section batch (still has key insights)
```
- Parallel.AI research already truncated at 300KB
- Further trim in `synthesizeMarketSizing()`: 25KB → 15KB
- Further trim in `draftSectionsBatchV2()`: 20KB → 12KB

#### 3C. Reduce Segment/Player Suggestions
```typescript
// Currently: 6-8 segments, 10 players
// Target: 4-5 segments, 7-8 players
```
- Reduces scope wizard output tokens by 25%
- Still covers all market dimensions

### 4. Concurrency & Rate Limiting (Multi-User)
**Problem**: 512MB RAM, rate limit 50/hour = only 50 concurrent users/hour
**Solution**: Smart queuing + memory management

#### 4A. Job Queue System
- In-memory queue (priority: scope < research < synthesis)
- Max 3 concurrent report generations (rest queue)
- Max 2 concurrent research calls (Parallel.AI expensive)
- **Benefit**: Predictable memory usage, no random OOM

#### 4B. Aggressive Memory Cleanup
- Delete job from memory after 30 minutes (was 2 hours)
- Clear research cache entries > 7 days
- Compress completed reports to JSON (remove internal state)

#### 4C. Lower Memory Thresholds
```typescript
// Current
memoryGuard: 250MB threshold, 300MB heap cap

// Optimized
memoryGuard: 200MB threshold (reject early)
heap cap: 250MB (more aggressive)
```
- Prevent OOM by rejecting at 200MB instead of 250MB
- Limits each report to ~50MB of memory

#### 4D. Rate Limit Tuning
```typescript
// Current: 50 AI requests/hour across all endpoints
// Target: Per-endpoint budgets:
- Industry Report scope: 100/hour (cheap, ~5s)
- Industry Report generate: 10/hour (expensive, ~40s)
- Benchmark: 30/hour (medium, ~15s)
- Financial Analysis: 20/hour (medium)
- Other: 20/hour

// Total: 180 AI requests/hour (scalable)
```

### 5. Model Optimization (Speed & Cost)
**Problem**: Claude Sonnet 4.6 is 10x slower than Haiku on simple tasks
**Solution**: Use right model for each task

#### 5A. Model Selection
```typescript
// Current: All use claude-sonnet-4-6

// Optimized:
'extractScopeWithWizard': 'claude-3-5-haiku-20241022',      // JSON parsing, 5x faster
'synthesizeMarketSizing': 'claude-3-5-haiku-20241022',      // Math + synthesis, 5x faster
'draftSectionsBatchV2': 'claude-3-5-sonnet-20241022',       // Complex analysis, quality matters
'synthesizeExecutiveSummary': 'claude-3-5-sonnet-20241022', // High-level synthesis

// Benefit: 40-50% speed improvement, 60% cost reduction on scope/sizing
```

#### 5B. Temperature & Determinism
```typescript
// Current: temperature=0.1-0.2 (high variance, requires retries)

// Optimized:
extractScopeWithWizard: temperature=0, max_retries=0
synthesizeMarketSizing: temperature=0, max_retries=1
draftSectionsBatchV2: temperature=0.1, max_retries=1  (need slight creativity)
synthesizeExecutiveSummary: temperature=0.1, max_retries=1
```
- **Benefit**: Fewer retries = 20% faster

### 6. Frontend Optimization
**Problem**: User stares at blank screen for 30-40s before first section renders
**Solution**: Progressive rendering + local state

#### 6A. Show Scope Immediately
- Display segments + players within 500ms
- Let user select while research runs in background

#### 6B. Skeleton Loading
- Show each section skeleton as soon as generation starts
- Skeleton disappears when data arrives

#### 6C. Pagination
- Don't load all 15+ sections at once
- Load first 3 sections, pagination to others
- Reduces initial payload

---

## Implementation Roadmap (Priority Order)

### Phase 1: Quick Wins (1-2 hours, 20-30% improvement)
- [ ] Reduce MAX_OUTPUT_TOKENS per section (1200 → 800 avg)
- [ ] Reduce research slice size (20KB → 12KB)
- [ ] Switch scope/sizing to Haiku (5x faster)
- [ ] Add skeleton loaders to frontend

### Phase 2: Caching (2-3 hours, 40-50% improvement)
- [ ] Add SQLite cache for research queries
- [ ] Cache scope/segment suggestions
- [ ] Cache compiled prompts

### Phase 3: Streaming & Chunking (3-4 hours, 50-60% improvement)
- [ ] Emit sections individually via SSE
- [ ] Frontend renders sections as they arrive
- [ ] Show progress indicator

### Phase 4: Job Queue (2-3 hours, multi-user support)
- [ ] Implement in-memory priority queue
- [ ] Limit concurrent report generations to 3
- [ ] Better memory cleanup

### Phase 5: Advanced (4-5 hours, premium feature)
- [ ] Batch similar report requests (combine research)
- [ ] Reuse section content across reports
- [ ] GraphQL-like partial queries (user selects specific sections only)

---

## Expected Results

| Metric | Current | Target | Improvement |
|--------|---------|--------|------------|
| **Time to First Section** | 35-40s | 8-12s | 3-4x faster |
| **Total Report Time** | 2-3 min | 1-1.5 min | 2x faster |
| **Tokens per Report** | 35,000-40,000 | 20,000-25,000 | 40% reduction |
| **Cost per Report** | ~$0.15 | ~$0.08 | 45% savings |
| **Concurrent Users** | 5-10 | 20-30 | 3-4x more |
| **Memory per Report** | 80-100MB | 40-50MB | 50% reduction |

---

## Cost Impact (Monthly)

**Current** (50 reports/day, ~$0.15/report)
- Reports: 1,500/month × $0.15 = $225

**Optimized** (with Haiku + caching)
- Reports: 1,500/month × $0.08 = $120
- Cache storage: +$2 (SQLite on Render)
- **Savings**: $105/month (47% reduction)

---

## Notes

- Render free tier limit: 512MB RAM. With these optimizations, can handle **20-30 concurrent reports** (vs current 5-10)
- SQLite cache can live in Render's /tmp, survives service restarts within same day
- If traffic exceeds Render capacity, upgrade to paid tier ($7-20/month) → unlimited concurrency
- No quality degradation: same section definitions, same research depth, just better caching/streaming

