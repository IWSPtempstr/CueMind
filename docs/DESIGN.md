---
name: CueMind
description: A restrained realtime meeting cognition interface for staying synchronized in technical conversations.
colors:
  void-bg: "#0a0a0a"
  app-bar: "#0a0a0a"
  panel-bg: "#171717"
  panel-bg-soft: "#17171780"
  field-bg: "#0a0a0a"
  border-strong: "#404040"
  border-subtle: "#262626"
  text-primary: "#ffffff"
  text-body: "#d4d4d4"
  text-muted: "#737373"
  text-faint: "#525252"
  action-blue: "#2563eb"
  action-blue-hover: "#3b82f6"
  focus-blue: "#3b82f6"
  danger-red: "#dc2626"
  danger-text: "#f87171"
  success-green: "#22c55e"
  warning-amber: "#fcd34d"
  source-blue: "#1e3a8a"
typography:
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "0"
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.05em"
  micro:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.05em"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
  modal: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-body}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  input-field:
    backgroundColor: "{colors.field-bg}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  suggestion-card:
    backgroundColor: "{colors.panel-bg-soft}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: CueMind

## 1. Overview

**Creative North Star: "The Meeting Control Room"**

CueMind should feel like a compact operations surface running beside a live technical conversation. The interface is dark because the user is likely sharing screen space with a video call, IDE, browser, or notes app; it must reduce glare, preserve focus, and let state changes register without turning the product into a visual spectacle.

The system is dense, restrained, and task-first. Three columns divide the live transcript, realtime suggestions, and deeper chat thread. Borders and tonal surfaces provide structure; blue is reserved for actions and selected state; red, green, amber, and category hues are semantic, not decorative. The product rejects generic AI chat centrality, meeting-minutes sprawl, and decorative monitoring-wall theatrics.

**Key Characteristics:**
- Dense three-column control-room layout with independent scroll regions.
- Near-black canvas with neutral tonal layers and thin dividers.
- Geist sans for all product UI, with Geist Mono only for prompt/code-like settings.
- Blue as the primary action/focus color, used sparingly.
- Flat by default, with depth conveyed through borders, tonal contrast, and state.

## 2. Colors

The palette is a restrained dark operational system: neutral layers carry the interface, blue carries action, and semantic colors carry state.

### Primary
- **Action Blue** (`{colors.action-blue}`): Primary buttons, user chat bubbles, resume actions, active controls, and focus affordances. Use it as a command color, not a decorative accent.
- **Focus Blue** (`{colors.focus-blue}`): Keyboard focus rings, selected field borders, and accessible active-state emphasis.

### Secondary
- **Source Blue** (`{colors.source-blue}`): Informational panels and sourced-context surfaces, such as meeting wrap-up or future explanation cards. Keep it translucent or low-coverage so it does not compete with primary actions.

### Tertiary
- **Danger Red** (`{colors.danger-red}` / `{colors.danger-text}`): Recording, stop, destructive, and failure states.
- **Success Green** (`{colors.success-green}`): Live audio level and successful signal indicators.
- **Warning Amber** (`{colors.warning-amber}`): Retry queues, temporary degradation, and recoverable pipeline delays.

### Neutral
- **Void Background** (`{colors.void-bg}`): Full-screen app background and footer base. It is the deepest layer.
- **Panel Background** (`{colors.panel-bg}`): Modal and primary raised panel surfaces.
- **Soft Panel Background** (`{colors.panel-bg-soft}`): Cards, suggestion tiles, and assistant surfaces that should be present but not dominant.
- **Field Background** (`{colors.field-bg}`): Inputs, selects, textareas, and embedded prompt editors.
- **Strong Border** (`{colors.border-strong}`): Form controls, card outlines, and visible interactive boundaries.
- **Subtle Border** (`{colors.border-subtle}`): Column dividers, section separators, and internal card rules.
- **Text Primary** (`{colors.text-primary}`): Card titles, active controls, user message text, and high-salience content.
- **Text Body** (`{colors.text-body}`): Transcript text, assistant answers, settings labels, and normal readable copy.
- **Text Muted** (`{colors.text-muted}`): Secondary labels, timestamps, status copy, and low-priority metadata.
- **Text Faint** (`{colors.text-faint}`): Empty states and background helper text only; avoid for required instructions.

### Named Rules

**The Accent Scarcity Rule.** Blue should occupy less than 10% of any screen. If blue covers a surface, it must represent an action, focus, or selected state.

**The Semantic Color Rule.** Red, green, amber, yellow, orange, purple, and category hues are allowed only when they encode system state or suggestion type.

## 3. Typography

**Display Font:** Geist, with `system-ui` fallback  
**Body Font:** Geist, with `system-ui` fallback  
**Label/Mono Font:** Geist for labels; Geist Mono for prompt textareas and code-like settings

**Character:** The typography is compact, technical, and quiet. It should read like a focused product console, not a marketing page or expressive editorial surface.

### Hierarchy
- **Title** (600, `1.125rem`, `1.5`): Modal titles and compact section headings that need more weight than a label.
- **Body** (400, `0.875rem`, `1.625`): Transcript chunks, assistant answers, card explanation copy, and settings descriptions. Keep long prose under 75ch when it appears in modal content.
- **Label** (500, `0.75rem`, `1.4`, tracked uppercase when structural): Column headers, setting labels, and control metadata.
- **Micro** (600, `0.625rem`, `1.25`, tracked uppercase): Status pills, timestamps, badges, and compact operational counters.
- **Mono** (400, `0.75rem`, `1.625`): Prompt templates and code-like local runtime paths.

### Named Rules

**The No-Hero-Type Rule.** CueMind is an app surface, not a landing page. Do not introduce oversized display typography or fluid hero headings into the working interface.

**The Label Discipline Rule.** Uppercase tracking is for system labels, statuses, and timestamps only. Never use it as a decorative eyebrow pattern.

## 4. Elevation

CueMind is flat by default. Depth comes from tonal layers, borders, and local state changes rather than drop shadows. The only visible shadow in the current system is the microphone control shadow, used to make the primary recording action tactile.

### Shadow Vocabulary
- **Control Lift** (`shadow-lg` on the microphone button): Use only for the primary recording control or a similarly central tactile control. Do not apply broad soft shadows to cards.

### Named Rules

**The Flat-By-Default Rule.** Cards, panels, and columns rest on borders and tonal contrast. If a card needs a shadow to be legible, the surface hierarchy is wrong.

**The No Ghost Card Rule.** Do not combine thin borders with wide decorative shadows on cards. CueMind should feel precise, not floaty.

## 5. Components

### Buttons

- **Shape:** Compact rectangular controls with gently curved edges (`4px` to `8px`), or full pills only for chips and status filters.
- **Primary:** Action Blue background with white text (`{colors.action-blue}` on `{colors.text-primary}`), `10px 20px` padding, semibold label, and a brighter hover blue.
- **Secondary:** Transparent or neutral-900 background, neutral border, muted body text, and a neutral hover fill.
- **Danger:** Red background only for stop/destructive realtime actions, never for passive warning text.
- **Hover / Focus:** Hover shifts fill or text color; keyboard focus uses a visible blue ring. Avoid transform choreography.

### Chips

- **Style:** Full-pill border or filled semantic badge. Text is micro-sized, often uppercase, and must preserve contrast against its background.
- **State:** Suggestion type chips use distinct semantic/category colors. Status chips use border plus text color rather than large filled surfaces.

### Cards / Containers

- **Corner Style:** Standard cards use `8px`; modals can use `12px`. Do not exceed `16px` on product surfaces.
- **Background:** Suggestion cards use soft neutral panels; assistant bubbles use neutral-800; user bubbles use Action Blue.
- **Shadow Strategy:** No shadow at rest. Use borders and tonal layers.
- **Border:** `1px` neutral borders are the main structural device. Avoid colored side-stripe borders.
- **Internal Padding:** Cards usually use `16px`; dense control rows use `8px` to `12px`.

### Inputs / Fields

- **Style:** Near-black field background, neutral-700 border, `6px` radius, `10px 12px` padding, neutral-200 text.
- **Focus:** Blue border plus a 1px blue focus ring.
- **Placeholder:** Placeholder text must not become essential instruction copy; keep required guidance outside the placeholder.
- **Error / Disabled:** Disabled controls reduce opacity; errors use red text near the control, not only red borders.

### Navigation

- **Style:** Minimal top bar with compact session controls. Navigation is operational rather than exploratory.
- **Typography:** Small uppercase product label and compact buttons.
- **State:** Saved session selector, export buttons, and settings control should remain scannable without stealing attention from the three columns.

### Realtime Transcript

Transcript items are plain text moments separated by subtle borders. Time appears as faint microcopy. Search highlights use translucent yellow, not full-saturation blocks. Future source labels for system audio and microphone should be compact chips adjacent to timestamps.

### Suggestion / Context Cards

Suggestion cards are tappable, bordered, and flat. The preview is the primary line. Actions such as pin, dismiss, copy, and feedback stay below a divider so they do not compete with the suggestion content. Future sourced context cards should preserve this compact hierarchy: keyword, one-sentence explanation, why-now line, two links, latency badge.

### Chat Bubbles

Chat exists as a secondary depth layer. User bubbles use blue; assistant bubbles use neutral-800. Quick previews may use a blue leading rule, but avoid making chat the main product center.

## 6. Do's and Don'ts

### Do:

- **Do** keep the three-column control-room structure as the default working surface.
- **Do** reserve blue for action, focus, selected state, and high-confidence source/context surfaces.
- **Do** use neutral borders (`#262626` / `#404040`) to separate panels, cards, and controls.
- **Do** make failure states readable in text, not just color.
- **Do** keep latency, retries, and source quality visible when they help the user trust the pipeline.
- **Do** use `8px` card radii and `6px` input/button radii unless the component is a pill.

### Don't:

- **Don't** make CueMind look or behave like a generic AI chat box. The chat input must not become the visual or interaction center.
- **Don't** make CueMind look like a meeting-minutes or knowledge-base tool. Avoid archive-first layouts, document-heavy screens, and long-form summaries as the default view.
- **Don't** make CueMind look like a decorative monitoring wall. Metrics support the task; they are not the show.
- **Don't** use gradient text, decorative grid backgrounds, glassmorphism, or hero-metric sections.
- **Don't** use colored side stripes on cards. If a state needs emphasis, use a full border, tonal background, chip, or explicit text.
- **Don't** exceed `16px` radius on cards, sections, modals, or fields.
