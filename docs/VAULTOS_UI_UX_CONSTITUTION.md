# VaultOS — UI/UX Design Constitution v1.0

**Purpose:** Master visual and interaction reference for VaultOS UI work and Codex implementation.

## 0. Product identity

VaultOS is a **private media sanctuary**: a local, privacy-first library where media is the star and smart organization feels effortless.

**Design formula:** familiar photo-library UX + Ente elegance + Linear precision + Recast personality + VaultOS cinematic character.

This is inspiration, not cloning. VaultOS must feel like its own product.

## 1. Non-negotiables

- Media comes first. **Hierarchy: media → atmosphere → controls.**
- Preserve existing functionality, API contracts, auth, filesystem semantics, SQLite semantics, face-processing behavior, upload behavior, and local-only privacy model.
- The filesystem `media/` remains the source of truth for media metadata/order. Do not invent new upload-date semantics.
- Recent and Most Viewed remain browser-local.
- UI work is staged in small, independently complete packages. Each package must leave the app usable.
- No wholesale rewrite unless a package explicitly requires it.
- Design must work intentionally in **dark and light** themes.
- Prefer reusable design tokens/components over scattered one-off CSS.

## 2. Current product baseline

The existing `index.html` already contains the functional visual foundation we are evolving:
- dark cinematic shell with sidebar and top bar
- search, upload, filters, sorting and layout controls
- virtualized media gallery
- media cards with image/video/favorite/face states
- cinematic/duo/dense gallery modes
- fullscreen lightbox with image/video viewing and navigation
- custom video controls
- People overview + person detail
- face-scan status/progress UI
- upload modal + background Upload Center
- modals, confirmation UI, toast feedback
- responsive/mobile navigation

The main problem is **not lack of features**. It is visual cohesion, hierarchy, polish, parity between themes, and consistency between surfaces.

## 3. Visual direction

### Dark mode
Deep, cinematic, quiet, immersive. Use layered dark neutrals, restrained translucency, soft atmospheric lighting, and selective accent glow.

### Light mode
Airy, gallery-like, crisp and calm. Use warm/cool near-white surfaces, clear separation, subtle borders, soft shadows, and the same hierarchy as dark mode.

### Accent
VaultOS red remains the signature accent. Red is for actions, active states, important feedback and controlled personality—not decoration everywhere.

### Avoid
Generic SaaS dashboard styling, excessive glassmorphism, giant gradients, excessive neon, excessive rounded cards, permanent control clutter, loud shadows, and cyberpunk-for-cyberpunk's-sake.

## 4. Reference board

### Ente Photos — borrow
Calmness, spacing, privacy-oriented confidence, elegant surfaces, media-first hierarchy, strong light/dark parity.

### Linear — borrow
Precision, information hierarchy, compact controls, excellent interaction states, restrained motion, keyboard-friendly feel.

### Recast — borrow
Personality, visual charm, playful polish, delight without sacrificing clarity.

### Apple Photos / Immich / PhotoPrism — borrow
Familiar media-library mental models, browse/search/filter patterns, People/face organization, viewer conventions, sensible navigation.

### Do not copy
Brand styling, exact layouts, exact colors, exact component shapes, or distinctive visual signatures. Combine principles into a VaultOS-specific language.

## 5. Design tokens

All future UI packages should converge on a shared token system.

### Color roles
- `bg`: application background
- `surface-1`: primary raised surface
- `surface-2`: secondary/elevated surface
- `surface-3`: control/input surface
- `text-1`: primary text
- `text-2`: secondary text
- `text-3`: tertiary/muted text
- `border-1`: subtle separators
- `border-2`: interactive borders
- `accent`: VaultOS red
- `accent-soft`: low-opacity accent background
- `success`, `warning`, `danger`: semantic feedback

Do not hard-code visually significant colors repeatedly when a token can represent the role.

### Geometry
Use a restrained radius scale. Small controls should feel precise; containers may be moderately rounded; media should remain visually dominant.

### Spacing
Use a consistent base spacing scale. Prefer breathing room over squeezing information together.

### Depth
Use three clear depth levels:
1. flat/background
2. raised surface
3. floating/overlay

Depth should communicate hierarchy, not decoration.

## 6. Typography

Primary UI type should remain highly readable and consistent.

- Use the existing VaultOS typography foundation unless there is a strong reason to change it.
- Display typography may carry personality.
- Monospace is for metadata, technical status, file information and compact utility text—not for the entire interface.
- Avoid excessive uppercase text.
- Typography hierarchy should be obvious without needing heavy font weight everywhere.

## 7. Motion

Motion should feel **calm, responsive and intentional**.

Use:
- short transitions for buttons/controls
- gentle elevation or opacity changes on hover
- restrained modal/lightbox entrance
- smooth gallery/view transitions
- clear progress choreography during scanning/uploads

Avoid:
- constant motion
- bouncing UI
- large transforms
- slow animations that delay interaction
- decorative animations that compete with media

Respect reduced-motion preferences.

## 8. App shell

The shell should visually recede behind the library.

### Sidebar
Keep the existing navigation model. Refine:
- hierarchy
- active state
- spacing
- icon alignment
- collapse behavior
- light/dark surfaces

The sidebar should feel like a refined library navigator, not an admin console.

### Top bar
Search is the primary utility. Upload and other global actions should be clear but visually secondary.

### Filters/sorting
Controls should feel like one coherent system. Avoid a row of unrelated “pills.”

### Responsive navigation
Mobile should be intentionally composed, not merely compressed desktop UI.

## 9. Gallery

The gallery is the visual heart of VaultOS.

### Principles
- thumbnails should dominate the viewport
- spacing should create rhythm
- metadata should be quiet
- controls should appear contextually
- hover/selection should add clarity, not visual noise
- loading should feel polished
- empty states should feel purposeful

### Layout modes
Existing layout modes (including dense/cinematic/duo-style presentation) should remain understandable and visually related rather than feeling like separate products.

### Media card rules
Default: image first, chrome second.
Favorite, media type, face count and other badges should be subtle and discoverable.
Never cover important image content unnecessarily.

### Selection
Selection must be obvious but elegant. It should not turn the gallery into a heavy enterprise table.

## 10. Media viewer

The viewer should feel like a dedicated media space, not a modal spreadsheet.

Priorities:
1. media
2. navigation
3. essential actions
4. metadata

Controls should recede when not needed and become discoverable on interaction.

Video controls should follow the same visual language as the rest of VaultOS.

Fullscreen/cinematic presentation is encouraged, especially in dark mode.

## 11. People

People is a major differentiator and should feel native to the VaultOS library.

### Overview
A visual people directory: face cover, name, count, restrained actions.

### Person detail
Reuse the familiar VaultOS media browsing model. Do not create a visually unrelated second gallery.

### Face operations
Rename, merge, delete, cover selection, manual assignment, “not this person,” scan and scan status must remain understandable and safe.

Dangerous actions require clear confirmation.

## 12. Upload experience

Uploading should feel like part of the library, not a separate utility app.

### Upload modal
Clear drop area, supported formats, queue, per-file state, progress, retry/cancel, concise feedback.

### Upload Center
Background progress should stay visible without hijacking the library.

State language should be human and clear:
- ready
- uploading
- completed
- failed / needs attention

## 13. Feedback and state design

Every interactive surface needs coherent:
- default
- hover
- focus
- active/selected
- disabled
- loading
- success
- warning
- error

Errors should explain what happened and what the user can do next.

Toasts are for lightweight feedback, not critical decisions.

## 14. Accessibility and responsive behavior

- Visible keyboard focus.
- Do not rely on color alone for state.
- Maintain readable contrast in both themes.
- Buttons must have usable hit areas.
- Dialogs need focus management and Escape behavior.
- Layout must remain usable at small widths and large displays.
- Respect reduced motion.

## 15. Package roadmap

### Package 0 — Blueprint / Recon
Document-only design decisions. No visual implementation.

### Package 1 — Global Visual Foundation
Theme system, tokens, typography, surfaces, borders, shadows, radii, animation primitives, dark/light parity.

**Constraint:** do not redesign the gallery yet.

### Package 2 — App Shell
Sidebar, top bar, search, filter system, sorting controls, status indicators, responsive navigation.

### Package 3 — Gallery
Cards, spacing, grid behavior, hover/selection, favorites, loading, empty states, media badges, layout switching.

### Package 4 — Media Viewer
Lightbox, image viewer, video player, actions, metadata, navigation, fullscreen, transitions.

### Package 5 — People
People landing, person cards, covers, person detail, cluster browsing, interactions, safe destructive flows.

### Package 6 — Upload
Drop zone, modal, queue, progress, completion, errors, background Upload Center.

### Package 7 — Final Polish
Micro-interactions, keyboard shortcuts, loading choreography, responsive refinements, accessibility, final consistency pass.

## 16. Codex operating rules

For every package:
1. Read this constitution first.
2. Inspect the current implementation before changing it.
3. Preserve working behavior unless the package explicitly changes presentation/interaction.
4. Prefer incremental edits over rewrites.
5. Reuse existing elements, IDs, and logic where practical.
6. Do not introduce a new visual language for one screen.
7. Validate both dark and light themes.
8. Validate responsive behavior.
9. Remove temporary/debug styling before finishing.
10. Finish the package in a stable state before moving on.

## 17. Definition of “done”

A UI package is done only when it is:
- visually coherent with this constitution
- functional with existing backend behavior
- consistent in dark + light
- responsive
- accessible at a practical level
- free of obvious visual regressions
- independently usable
- understandable without relying on later packages

## 18. Final test

Before accepting any UI change, ask:

**Does this make VaultOS feel more like a private media sanctuary, or more like a generic app?**

Choose the former every time.

---

**North star:** VaultOS should feel quiet when browsing, powerful when needed, delightful when interacted with, and unmistakably built around the user's media—not around the interface itself.
