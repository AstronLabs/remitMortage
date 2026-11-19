# Frontend Storybook

Storybook runs against the frontend's Next.js/React components and imports the
application global styles. Shared component stories live beside their component
as `*.stories.tsx` files under `frontend/src/components/`.

## Run locally

From `frontend/`:

```bash
npm ci
npm run storybook
```

Open <http://localhost:6006>. The Accessibility panel uses axe-core and checks
stories as they are opened.

## Add a story

Create a co-located `ComponentName.stories.tsx`, export a typed default
`Meta<typeof ComponentName>` and `StoryObj`, and add deterministic examples for
the component's supported states. Include empty, loading, and error variants
when the component or its containing state region can represent them; do not
invent states the component does not support. Prefer local sample data and
`storybook/test` callback spies. Stories must not call production services or
contain credentials.

The project-level `a11y.test: "error"` setting makes axe violations fail the
Storybook test suite. Do not disable a rule or mark a story as exempt without a
specific documented reason and review.

## Validate stories

From `frontend/`:

```bash
npx playwright install chromium
npm run test:storybook
npm run build-storybook
npm run lint -- src/components/ComponentName.stories.tsx
```

`npm run test:storybook` runs each story in headless Chromium through the
Storybook Vitest addon, including the accessibility checks. CI runs this suite
and builds the static catalog for frontend pull requests.

## Pull-request previews

The Storybook workflow uploads the static build as a 14-day GitHub Actions
artifact and links it in the workflow run summary. Download and extract the
artifact, then serve the extracted directory locally:

```bash
python3 -m http.server 8000 --directory storybook-static
```

The repository has no configured Vercel/Chromatic preview project or deployment
credentials. The artifact is therefore a reproducible preview build, not a
public hosted URL. Do not add deployment credentials to the repository; a
hosted preview requires an approved provider integration and its repository
configuration.
