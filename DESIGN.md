---
name: Coral
description: A local multi-agent orchestration command center for AI coding tools.
colors:
  deep-ink: "oklch(0.145 0.018 250)"
  ink-panel: "oklch(0.185 0.019 248)"
  graphite-rail: "oklch(0.235 0.018 247)"
  porcelain: "oklch(0.945 0.012 78)"
  muted-slate: "oklch(0.69 0.025 245)"
  signal-cyan: "oklch(0.74 0.118 202)"
  reef-green: "oklch(0.72 0.132 155)"
  amber-briefing: "oklch(0.78 0.125 82)"
  rose-critical: "oklch(0.67 0.18 25)"
  violet-agent: "oklch(0.68 0.135 292)"
typography:
  display:
    fontFamily: "\"Sora\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  body:
    fontFamily: "\"IBM Plex Sans\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 450
    lineHeight: 1.45
  mono:
    fontFamily: "\"IBM Plex Mono\", \"SF Mono\", ui-monospace, monospace"
    fontSize: "0.78rem"
    fontWeight: 450
    lineHeight: 1.55
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.deep-ink}"
    rounded: "{rounded.md}"
    padding: "9px 16px"
  panel:
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: Coral

## 1. Overview

**Creative North Star: "The Mission Atelier"**

Coral should feel like a bespoke control room where expert operators direct a fleet of local coding agents. The surface is dark because the usage scene is sustained monitoring and intervention on a developer workstation, often beside terminals and IDEs, where glare reduction matters. The dark theme is not decorative; it is a legibility and attention-management choice.

The aesthetic is precise, dense, and instrumented: machined graphite surfaces, warm paper text, cyan signal accents, compact controls, and clear state language. The UI earns its premium feel through alignment, crisp hierarchy, tuned motion, and a strong sense that every panel has a job.

## 2. Colors

The palette uses tinted ink neutrals with a cyan command signal and restrained operational semantic colors.

### Primary
- **Signal Cyan** (`oklch(0.74 0.118 202)`): primary actions, active navigation, focus rings, and live system highlights.

### Secondary
- **Reef Green** (`oklch(0.72 0.132 155)`): success, running, healthy, and completed states.
- **Amber Briefing** (`oklch(0.78 0.125 82)`): warnings, pending review, sleeping, and attention states.
- **Rose Critical** (`oklch(0.67 0.18 25)`): destructive actions, errors, stuck agents, and failed jobs.

### Neutral
- **Deep Ink** (`oklch(0.145 0.018 250)`): app background and terminal-adjacent shell.
- **Ink Panel** (`oklch(0.185 0.019 248)`): primary panels and elevated surfaces.
- **Graphite Rail** (`oklch(0.235 0.018 247)`): sidebars, rails, inactive controls, and separators.
- **Porcelain** (`oklch(0.945 0.012 78)`): primary text and high-emphasis icons.
- **Muted Slate** (`oklch(0.69 0.025 245)`): secondary text and metadata.

### Named Rules

**The Signal Rarity Rule.** Cyan appears where the operator can act or where live system state needs priority. It is not decoration.

## 3. Typography

**Display Font:** Sora with native sans fallbacks
**Body Font:** IBM Plex Sans with native sans fallbacks
**Label/Mono Font:** IBM Plex Mono with SF Mono fallback

**Character:** The pairing should feel engineered and editorial without becoming ornamental. Sora carries navigation and high-level hierarchy; Plex Sans carries dense product UI; Plex Mono anchors terminals, paths, IDs, costs, and system facts.

### Hierarchy
- **Display** (650, 1.5rem, 1.05): welcome headings, major empty states, and page-title moments.
- **Headline** (620, 1rem, 1.2): panel titles and active session names.
- **Title** (600, 0.875rem, 1.25): list items, section headers, modal groups.
- **Body** (450, 0.875rem, 1.45): descriptions, messages, docs, and helper text.
- **Label** (650, 0.68rem, 0.08em uppercase): metadata, badges, status labels, and command vocabulary.

## 4. Elevation

Depth is mostly tonal and structural. Shadows are reserved for popovers, modals, active overlays, and hover affordance. Static panels use borders, inner light, and surface contrast rather than heavy blur.

### Shadow Vocabulary
- **Panel Lift** (`0 18px 60px color-mix(in oklch, var(--bg-primary) 72%, transparent)`): important floating panels and modal surfaces.
- **Control Pop** (`0 10px 30px color-mix(in oklch, var(--accent) 18%, transparent)`): primary action hover and selected operational controls.

### Named Rules

**The No Fog Rule.** Blur is used only for top navigation and overlays where it preserves context. Panels should stay crisp.

## 5. Components

### Buttons
- **Shape:** compact rounded rectangles with 12px radius.
- **Primary:** signal cyan fill, deep ink text, subtle control shadow, no gradient text.
- **Hover / Focus:** color lift, visible outline, and slight translate on hover. Focus must remain visible without relying only on color.
- **Secondary:** graphite surface, porcelain text, precise border.

### Chips
- **Style:** uppercase micro-labels with tonal backgrounds and semantic color text.
- **State:** selected chips use stronger background and border; inactive chips stay quiet.

### Cards / Containers
- **Corner Style:** 18px to 24px for large panels, 10px to 12px for compact controls.
- **Background:** ink panel over deep ink with a subtle top highlight.
- **Shadow Strategy:** flat by default, lifted only for floating UI.
- **Border:** 1px tinted graphite border, never colored side stripes.
- **Internal Padding:** 12px to 24px based on density.

### Inputs / Fields
- **Style:** dark graphite well, 1px border, compact vertical rhythm.
- **Focus:** cyan outline with low-opacity halo.
- **Error / Disabled:** semantic color plus text or icon signal, never color alone.

### Navigation
- Top navigation uses compact tabs with active pill treatment. Sidebar rows use avatars, status dots, tight metadata, and clear selected state. Full-width views keep navigation present but reduce sidebar interference.

## 6. Do's and Don'ts

### Do:
- **Do** preserve dense expert workflows while improving hierarchy and affordance.
- **Do** use cyan sparingly for action and live state.
- **Do** show local execution context clearly: worktree, agent type, session state, and risk.
- **Do** respect reduced motion and keyboard navigation.
- **Do** keep terminal areas legible and visually separate from dashboard chrome.

### Don't:
- **Don't** use decorative purple gradients, neon AI dashboard styling, or crypto-terminal aesthetics.
- **Don't** use glassmorphism as the default panel language.
- **Don't** use colored side-stripe borders as emphasis.
- **Don't** hide local execution risk behind friendly copy.
- **Don't** make agent coordination feel like a generic chat app.
