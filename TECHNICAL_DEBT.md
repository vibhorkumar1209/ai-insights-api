# Technical Debt & Future Improvements

## Type Consolidation (High Priority)

### Issue
The frontend (`ai-insights-app/src/lib/types.ts`) and backend (`ai-insights-api/src/types/index.ts`) define **50 identical TypeScript interfaces**.

This creates maintenance burden:
- Changes to a type must be made in two places
- Risk of inconsistency between frontend and backend definitions
- Duplicate code violates DRY principle

### Duplicated Types (50 Total)

#### Market & Sizing Data
- `MarketSegmentOption` - Market segment selection with ID
- `KeyPlayerOption` - Company player selection with description
- `MarketSizingData` - Sizing data with TAM/SAM/SOM
- `MacroTEIData`, `MacroTEIItem` - Total Economic Impact data

#### Financial Data
- `QuarterlyDataPoint` - Quarterly revenue/margin data
- `RevenueDataPoint` - Annual revenue tracking
- `MarginDataPoint` - Operating/net margin data
- `FinancialSegmentRow` - Revenue by business segment
- `FinancialStatementRow` - Income statement line items
- `GeoRow` - Revenue by geography

#### Competitor & Analysis
- `Competitor` - Basic competitor info
- `CompetitorProfile` - Detailed competitor profile
- `BenchmarkDimension` - Peer benchmarking dimensions
- `GapAnalysisRow` - Performance gap data
- `CompanyInfo` - Stock market company data

#### Report & Chart Data
- `ReportChartSpec` - Chart specification
- `ChartDataPoint`, `ChartSeriesConfig` - Chart data structures
- `ReportSection`, `ReportSubsection` - Report structure
- `ExecutiveSummaryTickerBox` - Stock ticker display

#### Porter's & SWOT Analysis
- `PortersForcesData`, `ForceAnalysis` - Porter's Five Forces
- `SWOTData`, `SWOTItem` - SWOT analysis data

#### Other Data Structures
- `BCGMatrixItem` - BCG matrix positions
- `ChallengesGrowthRow` - Challenges & growth opportunities
- `IndustryTrendRow`, `IndustryDynamicsRow`, `IndustryDynamicsItem`
- `KeyBuyerRow` - Key buyer analysis
- `KeyHighlightsStructured` - Report highlights
- `NicheTopicRow`, `NicheDataPoint` - Niche industry data
- `SalesPlayPriorityRow`, `SalesPlayIndustrySolution`, `SalesPlayPartner`, `SalesPlayCaseStudy`, `SalesPlayPriorityMapping`, `SalesPlayObjectionRebuttal`
- `ThemeRow`, `ThemeType` - Business/tech/sustainability themes
- `IndustryReportScope` - Industry report scope configuration
- `BenchmarkJob`, `BenchmarkFormData` - Peer benchmarking job types
- `ChallengesGrowthJob`, `ThemesJob`, `FinancialAnalysisJob` - Job types

### Current State

**Frontend Definition**: `/ai-insights-app/src/lib/types.ts` (680 lines)
- Contains all 50 duplicated types
- Used by React components and API clients
- Source of truth: NO (both are authoritative)

**Backend Definition**: `/ai-insights-api/src/types/index.ts` (726 lines)
- Contains all 50 duplicated types with documentation
- Used by Express route handlers and services
- Source of truth: SHOULD BE (better documentation)

### Recommended Solutions (Priority Order)

#### Solution 1: Monorepo with Workspaces ⭐⭐⭐ (Recommended)

Create a shared types package that both frontend and backend depend on.

**Steps**:
1. Create `packages/types/src/index.ts` with all consolidated types
2. Create `packages/types/package.json` and build config
3. Update both `ai-insights-app/package.json` and `ai-insights-api/package.json` to depend on `@ai-insights/types`
4. Replace imports in both packages:
   ```typescript
   // Before
   import { ReportSection, Competitor } from './types';
   
   // After
   import { ReportSection, Competitor } from '@ai-insights/types';
   ```
5. Remove duplicate definitions from both

**Benefits**:
- Single source of truth
- Type safety across packages
- Easy to update types once
- Industry standard pattern (used by Next.js, React, TypeScript)

**Effort**: Medium (2-4 hours)

#### Solution 2: Generate Types from OpenAPI Schema

Use OpenAPI/Swagger to define API contracts, generate types automatically.

**Steps**:
1. Create `openapi.yaml` documenting all API endpoints and response types
2. Use `openapi-typescript-generator` to generate types
3. Backend generates types during build
4. Frontend imports generated types

**Benefits**:
- API documentation as code
- Single source of truth in API spec
- Automatically stays in sync
- Better API versioning support

**Effort**: High (8-12 hours) - requires API spec expertise

#### Solution 3: Shared NPM Package

Publish types to npm.org or private registry.

**Steps**:
1. Create standalone types package in separate repo
2. Publish to npm (public or GitHub package registry)
3. Both packages add to `package.json`
4. Import from `@ai-insights/types` package

**Benefits**:
- Completely decoupled from main repos
- Can be versioned independently
- Shareable with external partners

**Effort**: Medium-High (3-5 hours) - requires npm registry setup

#### Solution 4: Sync Script (Short-term)

Create a script that keeps frontend types synchronized with backend.

**Steps**:
1. Create script: `scripts/sync-types.js`
2. Copies types from backend to frontend
3. Run before commits via pre-commit hook
4. Update types only in backend source

**Benefits**:
- Quick to implement
- Maintains backward compatibility
- Can be done immediately

**Downsides**:
- Still not true single source of truth
- Extra build step
- Temporary solution

**Effort**: Low (1-2 hours)

### Implementation Plan

**Immediate** (Next Sprint):
- Option 4: Implement sync script to prevent further divergence
- Document all 50 types and their purpose

**Short-term** (2-3 Sprints):
- Option 1: Migrate to monorepo with workspaces
- Consolidate types in `packages/types`
- Update imports in both packages

**Long-term** (Next Quarter):
- Option 2: Implement OpenAPI schema for all endpoints
- Auto-generate types from schema
- Deprecate manual type definitions

---

## Other Technical Debt

### Dead Code Analysis

7 potentially unused components identified in frontend:
- Requires ESLint plugin `eslint-plugin-unused-imports` or SonarQube for accurate detection
- Some may be: internal utility functions, dead code branches within used files, old function signatures

**Recommendation**: Run static analysis tool before next cleanup pass

### Type Strengthening

Successfully reduced ~10 `any` type casts in chart components (SegmentChart, QuarterlyChart, etc.)

Remaining work:
- ReportChart.tsx still has 8 `any` declarations (complex Recharts props)
- Some utilities in exportReport.ts use `any` for docx library types
- These are justified until Recharts and docx export better TypeScript types

---

## Performance Opportunities

### Caching
- Consider Redis caching for research results (currently single-request per job)
- Cache market sizing results by industry/geography combinations

### Code Splitting
- Frontend: Split chart components into separate bundles
- Backend: Separate research service into microservice

### Database
- Currently all data in-memory (JobStore)
- Consider Postgres for job history and results persistence

---

## Security Improvements

### API Rate Limiting
- Currently: 10 AI requests/hour, 30 general/15min
- Consider: Per-user rate limiting vs global
- Add: API key authentication for external use

### Input Validation
- Add schema validation (Zod/Joi) for all API inputs
- Validate scope, segment, player selections before processing

### Environment Variables
- Audit all .env usage
- Consider: Secrets management service (AWS Secrets Manager, HashiCorp Vault)

---

## Documentation Improvements

- [ ] Create architecture diagram (data flow, component relationships)
- [ ] Document all API endpoints in OpenAPI format
- [ ] Add runbook for common troubleshooting (Render spins down after 15min idle)
- [ ] Create performance baseline metrics

---

**Last Updated**: April 17, 2026
**Tracked By**: Claude Code 7-Track Cleanup Initiative
