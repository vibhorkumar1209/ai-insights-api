# Monorepo Tools Evaluation & Migration Plan

## Current State

```
Visual Studio/
├── ai-insights-app/          (Next.js 14 frontend, ESM)
│   ├── package.json
│   ├── tsconfig.json         (moduleResolution: "bundler", module: "esnext")
│   ├── next.config.js
│   └── src/
├── ai-insights-api/          (Express backend, CommonJS)
│   ├── package.json
│   ├── tsconfig.json         (module: "commonjs", target: "ES2020")
│   └── src/
├── package.json              (Root - minimal, only autocannon)
└── TECHNICAL_DEBT.md
```

**Key Constraints**:
- Frontend: Next.js 14, ESM modules, Vercel deployment
- Backend: Express + ts-node, CommonJS, Render deployment
- Both have separate `node_modules`
- 50 duplicated types between them
- Separate git repositories (not local monorepo)

---

## Tool Comparison

### 1. Yarn Workspaces ⭐⭐⭐

**What It Is**: Dependency hoisting system built into Yarn 1.x+. Treats multiple `package.json` files as a single workspace.

#### Strengths
- ✅ Minimal setup (just add `workspaces` field in root `package.json`)
- ✅ Automatic dependency hoisting (shared node_modules)
- ✅ Built into Yarn, no additional tool needed
- ✅ Works with existing Next.js and Express setups
- ✅ Good for your case: separate build systems (Next vs tsc)
- ✅ Works with Vercel and Render without changes
- ✅ Can import types between packages easily

#### Weaknesses
- ❌ Limited task orchestration (no built-in monorepo task running)
- ❌ Requires Yarn (must migrate from npm)
- ❌ Yarn 1.x is older (though Yarn 2+ exists)
- ❌ No built-in build caching across packages

#### Use Case Fit
**GOOD**: Simple monorepo with 2-3 packages, each with independent build pipeline

#### Setup Complexity
```json
// Root package.json
{
  "private": true,
  "workspaces": [
    "packages/types",
    "ai-insights-api",
    "ai-insights-app"
  ]
}
```
**Effort**: 30 minutes

---

### 2. pnpm ⭐⭐⭐⭐

**What It Is**: NPM-compatible package manager with built-in monorepo support via workspaces.

#### Strengths
- ✅ Drop-in npm replacement (mostly compatible commands)
- ✅ Native monorepo support (better than npm workspaces)
- ✅ Content-addressable storage (saves disk space)
- ✅ Fast installation (faster than npm/yarn)
- ✅ Works seamlessly with Vercel and Render
- ✅ Excellent dependency isolation (no phantom deps)
- ✅ Works with Next.js, Express, TypeScript out of box
- ✅ Growing ecosystem adoption (Turborepo uses pnpm)
- ✅ Easy type sharing between packages
- ✅ Supports recursive scripts (`pnpm -r run build`)

#### Weaknesses
- ❌ Slightly different from npm (learning curve)
- ❌ Some npm packages may have compatibility issues
- ❌ Requires new lock file format (pnpm-lock.yaml)
- ❌ CI/CD environments need pnpm installed

#### Use Case Fit
**EXCELLENT**: Growing projects with multiple packages, good for monorepos

#### Setup Complexity
```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/types'
  - 'ai-insights-api'
  - 'ai-insights-app'
```
**Effort**: 45 minutes

---

### 3. Turborepo ⭐⭐⭐⭐⭐

**What It Is**: High-performance monorepo orchestration tool that works with pnpm, npm, or yarn.

#### Strengths
- ✅ Best-in-class monorepo task orchestration
- ✅ Parallel builds with dependency graph
- ✅ Built-in caching (builds only what changed)
- ✅ Remote caching support (Vercel integration)
- ✅ Works with pnpm, npm, or yarn
- ✅ Optimized for performance at scale
- ✅ Excellent CI/CD integration
- ✅ Works perfectly with Vercel (by Vercel team)
- ✅ Great for multi-package setups
- ✅ Can speed up local dev and CI pipelines
- ✅ TypeScript aware (type checking parallelization)

#### Weaknesses
- ❌ Requires additional tool beyond package manager
- ❌ Learning curve (cache config, task pipelines)
- ❌ Overkill for simple 2-3 package monorepo
- ❌ Extra complexity in early stages
- ❌ More configuration needed

#### Use Case Fit
**GOOD BUT OVERKILL NOW**: Better for 5+ packages or heavy CI/CD usage. Could be future-proofed choice.

#### Setup Complexity
```json
// Root package.json (pnpm-based)
{
  "private": true,
  "packageManager": "pnpm@8.0.0"
}

// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```
**Effort**: 2-3 hours (including Vercel caching setup)

---

## Comparison Matrix

| Feature | Yarn WS | pnpm | Turborepo |
|---------|---------|------|-----------|
| **Setup Time** | ⚡ 30min | ⚡ 45min | ⚠️ 2-3h |
| **Complexity** | ✅ Low | ✅ Low-Medium | ⚠️ Medium |
| **npm Compatibility** | ⚠️ Switch to Yarn | ✅ High | ✅ Works with npm |
| **Build Performance** | ⚠️ Sequential | ✅ Fast | ⭐ Fastest (cached) |
| **CI/CD Integration** | ⚠️ Manual scripts | ✅ Good | ⭐ Excellent |
| **Vercel Support** | ✅ Works | ✅ Works | ⭐ Native |
| **Render Support** | ✅ Works | ✅ Works | ✅ Works |
| **Type Sharing** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Scalability** | ⚠️ 2-3 packages | ✅ 5-10 packages | ⭐ 10+ packages |
| **Future-Proof** | ⚠️ Aging | ✅ Growing | ⭐ Best choice |

---

## Recommendation: **pnpm** ⭐⭐⭐⭐

**Why pnpm for your project**:

1. **Right Balance**: Not overkill like Turborepo, but more powerful than Yarn workspaces
2. **npm-like**: Easier migration than switching to Yarn
3. **Future Growth**: If you expand to more packages later, pnpm scales better
4. **Deployment Ready**: Works seamlessly with Vercel and Render
5. **Performance**: Faster installs and builds as monorepo grows
6. **Ecosystem**: Growing adoption, better tooling support

**If you want absolute simplicity**: Use Yarn workspaces
**If you want maximum scalability/performance**: Use Turborepo + pnpm

---

# Migration Plan: pnpm Monorepo

## Phase 1: Preparation (30 min)

### 1.1 Backup Current State
```bash
cd "/Users/vibhor/Visual Studio"
git checkout -b feature/monorepo-setup
# Verify both repos are committed
cd ai-insights-app && git status
cd ../ai-insights-api && git status
```

### 1.2 Create Directory Structure
```
Visual Studio/
├── packages/
│   ├── types/              # NEW: Shared types
│   │   ├── package.json
│   ├── ui/                 # OPTIONAL: Shared React components
│   │   ├── package.json
├── ai-insights-api/        # Existing
├── ai-insights-app/        # Existing
├── pnpm-workspace.yaml     # NEW
└── package.json            # Update existing
```

---

## Phase 2: Set Up pnpm Workspace (1-2 hours)

### 2.1 Install pnpm
```bash
npm install -g pnpm@8.0.0   # Latest stable
pnpm --version              # Verify
```

### 2.2 Create Root Configuration Files

**File: `/Users/vibhor/Visual Studio/pnpm-workspace.yaml`**
```yaml
packages:
  - 'packages/types'
  - 'packages/ui'              # Optional: future UI components
  - 'ai-insights-api'
  - 'ai-insights-app'

catalogs:
  react:
    react: ^18
    react-dom: ^18
```

**File: `/Users/vibhor/Visual Studio/package.json`** (Update)
```json
{
  "private": true,
  "packageManager": "pnpm@8.0.0",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "pnpm -r run lint",
    "types:check": "pnpm --filter=@ai-insights/types run build",
    "api:dev": "pnpm --filter=ai-insights-api run dev",
    "app:dev": "pnpm --filter=ai-insights-app run dev",
    "api:build": "pnpm --filter=ai-insights-api run build",
    "app:build": "pnpm --filter=ai-insights-app run build"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

### 2.3 Create packages/types Directory
```bash
mkdir -p packages/types/src
```

**File: `/Users/vibhor/Visual Studio/packages/types/package.json`**
```json
{
  "name": "@ai-insights/types",
  "version": "1.0.0",
  "description": "Shared type definitions for AI Insights",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "files": ["dist"],
  "devDependencies": {
    "typescript": "workspace:*"
  }
}
```

**File: `/Users/vibhor/Visual Studio/packages/types/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "esnext",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Phase 3: Consolidate Types (2-3 hours)

### 3.1 Extract Backend Types as Source of Truth
```bash
# Copy backend types to packages/types/src
cp ai-insights-api/src/types/index.ts packages/types/src/index.ts
```

### 3.2 Clean Up Backend Types
```bash
# Keep one version in ai-insights-api/src/types
# OR symlink to shared types (pnpm handles this)
```

### 3.3 Update Frontend Import Path
**Before**:
```typescript
// ai-insights-app/src/lib/types.ts
export interface ReportSection { ... }
```

**After**:
```typescript
// ai-insights-app/src/lib/types.ts
export * from '@ai-insights/types';
```

---

## Phase 4: Update Package Dependencies (1-2 hours)

### 4.1 Update ai-insights-api/package.json
```json
{
  "dependencies": {
    "@ai-insights/types": "workspace:*",
    // ... existing deps
  }
}
```

Import usage:
```typescript
// OLD
import { ReportSection } from '../types';

// NEW  
import { ReportSection } from '@ai-insights/types';
```

### 4.2 Update ai-insights-app/package.json
```json
{
  "dependencies": {
    "@ai-insights/types": "workspace:*",
    // ... existing deps
  }
}
```

Import usage:
```typescript
// OLD
import { ReportSection } from '@/lib/types';

// NEW
import { ReportSection } from '@ai-insights/types';
```

---

## Phase 5: Build & Test (1-2 hours)

### 5.1 Install Dependencies
```bash
cd "/Users/vibhor/Visual Studio"
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### 5.2 Build Monorepo
```bash
pnpm types:check          # Build shared types
pnpm api:build            # Build backend
pnpm app:build            # Build frontend
pnpm build                # Build all
```

### 5.3 Local Development Testing
```bash
# Terminal 1: Backend
pnpm api:dev

# Terminal 2: Frontend  
pnpm app:dev

# Test endpoints
curl http://localhost:4000/api/health
open http://localhost:3000
```

### 5.4 Verify Imports Work
```bash
# TypeScript should recognize @ai-insights/types
pnpm types:check
pnpm api:build
pnpm app:build
```

---

## Phase 6: Update CI/CD & Deployment (1-2 hours)

### 6.1 Vercel (Frontend) - Update Build Settings
```bash
# File: vercel.json (create in root or ai-insights-app)
{
  "buildCommand": "pnpm build --filter=ai-insights-app",
  "outputDirectory": ".next"
}
```

OR in Vercel Dashboard:
- **Build Command**: `pnpm build --filter=ai-insights-app`
- **Install Command**: `pnpm install`
- **Output Directory**: `ai-insights-app/.next`

### 6.2 Render (Backend) - Update Build Settings
```bash
# In Render Dashboard:
# Build Command: pnpm build --filter=ai-insights-api
# Start Command: pnpm --filter=ai-insights-api run start
```

### 6.3 GitHub Actions (if using)
```yaml
name: Build & Test

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
```

---

## Phase 7: Git & Cleanup (30 min)

### 7.1 Update .gitignore
```bash
# Root .gitignore (add if not present)
node_modules/
dist/
.turbo/
pnpm-lock.yaml  # Some teams check this in, some don't
```

### 7.2 Commit Monorepo Setup
```bash
git add packages/ pnpm-workspace.yaml package.json
git commit -m "feat: Set up pnpm monorepo with shared types package

- Create packages/types with consolidated type definitions
- Update ai-insights-api to depend on @ai-insights/types
- Update ai-insights-app to depend on @ai-insights/types
- Add pnpm-workspace.yaml for monorepo configuration
- Add helpful npm scripts for multi-package management
- Prepare for Vercel and Render deployment

This consolidates 50 duplicated type definitions into a single
source of truth, reducing maintenance burden and ensuring type
consistency across frontend and backend.

Workspace structure:
- packages/types: Shared TypeScript types
- ai-insights-api: Express backend
- ai-insights-app: Next.js frontend

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### 7.3 Clean Up Old Type Files
```bash
# Remove duplicate definitions
# ai-insights-api/src/types/index.ts - KEEP (can symlink to packages/types)
# ai-insights-app/src/lib/types.ts - REMOVE (now imports from @ai-insights/types)

git rm ai-insights-app/src/lib/types.ts
git commit -m "refactor: Remove duplicated types from frontend

Frontend now imports all types from @ai-insights/types workspace package.
This eliminates 50+ duplicated type definitions and establishes backend
as the source of truth for shared types.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Phase 8: Verify Deployments (1-2 hours)

### 8.1 Test Production Deployments
```bash
# Push to main
git push origin feature/monorepo-setup
# Create PR, review, merge

# Monitor deployments:
# Vercel: https://vercel.com/vibhorkumar1209s-projects/ai-insights-app
# Render: https://ai-insights-api-1.onrender.com/health
```

### 8.2 Smoke Tests
```bash
# Frontend loads
curl https://ai-insights-app-six.vercel.app

# Backend responds
curl https://ai-insights-api-1.onrender.com/health

# API call works end-to-end
# Test in application UI
```

---

## Timeline & Effort Estimate

| Phase | Duration | Tasks |
|-------|----------|-------|
| **1. Preparation** | 30 min | Backup, directory setup |
| **2. pnpm Setup** | 1-2h | Install, config, root files |
| **3. Type Consolidation** | 2-3h | Extract, organize, clean |
| **4. Update Dependencies** | 1-2h | Import paths, package.json |
| **5. Build & Test** | 1-2h | Install, build, verify |
| **6. CI/CD Updates** | 1-2h | Vercel, Render, Actions |
| **7. Git & Cleanup** | 30 min | Commits, final cleanup |
| **8. Deployment Verification** | 1-2h | Test production |
| **TOTAL** | **8-15 hours** | ~1 business day |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Breaking existing deployments** | Create feature branch, test locally first, gradual rollout |
| **Type import errors** | Keep dual imports temporarily, test both paths before cleanup |
| **pnpm incompatibility** | Some npm packages don't work with pnpm (rare). Use npm override in worst case |
| **Vercel/Render detection** | Update build commands explicitly in dashboard settings |
| **Team workflow changes** | Document new commands (pnpm instead of npm) |

---

## Rollback Plan

If issues arise:

```bash
# Revert to npm monorepo (temporary)
git revert <commit>
rm pnpm-lock.yaml
npm install

# OR switch to Yarn workspaces (alternative)
npm install -g yarn
yarn install
```

---

## Success Criteria

✅ `pnpm install` completes without errors
✅ `pnpm build` builds all packages successfully
✅ `pnpm app:dev` starts Next.js frontend
✅ `pnpm api:dev` starts Express backend
✅ Frontend can import types from `@ai-insights/types`
✅ Backend can import types from `@ai-insights/types`
✅ Vercel deployment succeeds
✅ Render deployment succeeds
✅ No regressions in API functionality

---

## Post-Migration Improvements

Once monorepo is stable, consider:

1. **packages/ui** - Shared React components (Recharts wrappers, FormField, etc.)
2. **Turborepo** - Add for parallel builds and caching (future)
3. **shared/eslint-config** - Unified lint rules
4. **shared/tsconfig** - Unified TypeScript config
5. **Automated type checking** - Pre-commit hooks with husky

---

## Command Reference

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build specific package
pnpm build --filter=@ai-insights/types
pnpm build --filter=ai-insights-api
pnpm build --filter=ai-insights-app

# Develop all packages (parallel)
pnpm -r --parallel run dev

# Develop specific package
pnpm dev --filter=ai-insights-app
pnpm dev --filter=ai-insights-api

# Run tests
pnpm -r run test

# Add dependency to specific package
pnpm add lodash --filter=@ai-insights/types

# Add shared dependency (devDependency)
pnpm add -D typescript -w   # -w for workspace root
```

---

**Next Step**: Begin Phase 1 preparation when ready. Estimated completion: Next sprint (1 business day effort spread over 2-3 days).
