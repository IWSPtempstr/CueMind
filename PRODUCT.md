# Product

## Register

product

## Platform

web

## Users

CueMind serves individual users in technical interviews and technical meetings who need to keep pace with live discussion. They are listening under time pressure, often while unfamiliar terms, model names, systems, metrics, or papers are being mentioned faster than they can manually search.

The primary workflow is realtime comprehension support: the user watches the transcript, receives short explanation cards, checks source links when needed, and uses the assistant to stay present in the conversation. This is not primarily a meeting-notes product or a post-meeting knowledge base.

## Product Purpose

CueMind is a realtime meeting cognition assistant. It captures meeting context, identifies technical keywords while the topic is still active, retrieves supporting background, and renders compact Chinese explanation cards that are fast enough to read during the meeting.

Success means the user can recover context in seconds without leaving the conversation. For the desktop MVP, success is demonstrated by a 10-minute technical meeting recording that produces 3-5 sourced cards and a visible latency breakdown against a P50 <= 8s and P95 <= 15s card-latency budget.

## Positioning

CueMind is a realtime cognitive overlay for meetings: it explains the keyword before the conversation moves on.

The supporting proof points are local-first privacy boundaries and a measurable realtime AI pipeline. Audio, transcript, ASR, and card generation should stay local by default; external web search is an explicit enhancement for sourced context. Latency, retries, failures, and replay should be visible enough for engineering review, not hidden behind a polished demo.

## Brand Personality

The product should feel restrained, sharp, and trustworthy. It should read as a serious tool for staying mentally synchronized in a live technical conversation.

The interface can carry a transparent and debuggable engineering character, but the telemetry must support the task rather than becoming the main spectacle. The voice should be direct, concise, and operational: short labels, clear failures, no performative AI personality.

## Anti-references

CueMind should not look or behave like a generic AI chat box. The conversation input must not become the center of gravity, and the product should avoid long answers, vague summaries, and chat-first interaction patterns.

CueMind should not look like a meeting-minutes or knowledge-base tool. The product should prioritize live comprehension windows over after-the-fact documentation, archive management, or broad knowledge capture.

CueMind should not look like a decorative monitoring wall. Latency and pipeline state matter, but charts, colors, and operational metrics must not overwhelm the transcript and explanation cards.

## Design Principles

Use cards only when they beat conversation speed. A card is valuable when it arrives while the topic is still alive and gives enough context to continue listening.

Keep the transcript and cards in a tight operational loop. The user should always understand which recent speech produced a card and whether it came from system audio or microphone input.

Make source quality visible. Official explanation cards need traceable links; if sources are insufficient, the product should skip or clearly mark the failure instead of pretending certainty.

Expose the pipeline without turning it into the product. ASR, keyword detection, search, LLM generation, render latency, retries, and replay are important because they build trust and make failures debuggable.

Prefer dense clarity over decorative polish. The UI should preserve the existing control-room density, use restrained color, and reserve emphasis for state, source quality, and user action.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Body text and controls need sufficient contrast, visible keyboard focus, semantic labels for icon-only buttons, accessible state announcements for recording and generation, and usable reduced-motion behavior.

The product should remain understandable for users under meeting pressure. Error states must be explicit, source labels should not rely on color alone, and latency/status indicators should be readable without requiring the user to interpret complex charts.
