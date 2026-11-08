# Building Agent Harness from Scratch

A minimal TypeScript implementation of two kinds of AI harness, built for a talk on "Building Agent Harness from Scratch" at the JagoanHosting event.

This is my write-up to accompany the talk and slides.

---

## What is an AI harness?

An AI harness is the infrastructure that gives an AI model its tools and manages input/output behind the scenes, so the model has the context and environment it needs to do what's asked. It's the scaffolding that wraps around an LLM to make it useful for real-world tasks: not just answering one prompt, but doing actual work in a loop.

The clearest one-liner: **an AI harness is everything except the model weights.**

In practice, that means tool interfaces, context and memory handling, guardrails, verification steps, approval gates, logging, and recovery loops. Anthropic calls its Claude Agent SDK a "general-purpose agent harness", with built-in context management and tool use so Claude can work as a long-running assistant. OpenAI describes the same idea as orchestration, while Anthropic calls the context layer context engineering.

---

## What is harness engineering?

Harness engineering shifts the engineer's job from writing code to designing environments, specifying intent, and providing structured feedback. The harness is the moat. The model is rented.

According to Thoughtworks and OpenAI, a harness has three core components:

1. **Context engineering**: deciding what information to include or exclude at each model call.
   - Isolation: keep subtasks separate.
   - Reduction: drop stale data to avoid context rot.
   - Retrieval: inject fresh docs or search results at the right time.
2. **Architectural constraints**: rules enforced not just by the model, but by deterministic linters, structural tests, and guardrails the model cannot bypass.
3. **Verification and feedback loops**: the harness checks outputs and runs eval steps. If something is wrong, it surfaces the problem so the agent or the engineer can fix it.

---

## Core references
OpenAI: Harness engineering: leveraging Codex in an agent-first world
Anthropic: Effective harnesses for long-running agents
Anthropic: Harness design for long-running application development
Awesome Harness Engineering

## Supporting References
https://arxiv.org/html/2606.10106v1
https://cloud.google.com/discover/agent-harness
https://www.datacamp.com/blog/agent-harness
https://vercel.com/eve
https://www.youtube.com/watch?v=-ESSuPpJ5r8&t=2079s

## Additional References
- [claude-code](https://github.com/yasasbanukaofficial/claude-code): Claude Code source backup used for mechanism names and implementation paths.
- [hermes-agent](https://github.com/NousResearch/hermes-agent): Open-source agent harness (MIT) used as the second system under study.
- [mini-swe-agent](https://github.com/swe-agent/mini-swe-agent): Minimal SWE agent (MIT) used as the third system under study.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): Plugin-based agent harness (MIT) used as the fourth system under study.
- [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code): Code-first harness reconstruction and section framing.
- [EvalGrill](https://github.com/hardness1020/EvalGrill): companion tool (Apache-2.0) that applies section 23, building eval sets from real agent-application cases.
- [Anthropic Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): Progressive disclosure levels for skills.
- [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering): Loop building blocks and readiness levels.
- [LangChain · The art of loop engineering](https://www.langchain.com/blog/the-art-of-loop-engineering): The four stacked loops.
- [Addy Osmani · Loop engineering](https://addyosmani.com/blog/loop-engineering/): Composed building blocks for agent loops.
- [MindStudio · What is loop engineering](https://www.mindstudio.ai/blog/what-is-loop-engineering-autonomous-ai-agent-workflows): Goal conditions for autonomous workflows.
- [Lilian Weng · Harness engineering for self-improvement](https://lilianweng.github.io/posts/2026-07-04-harness/): The improvement loop, with gates outside the loop.
- [LangChain · 3 years of graph engineering](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph): Nodes, edges, cycles, and agents as nodes.
- [Anthropic · Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): Workflows vs agents and the five workflow shapes.
- [Google · Why we built ADK 2.0](https://developers.googleblog.com/en/why-we-built-adk-20/): Routing in code and context isolation between nodes.
- [ai-agent-book](https://github.com/bojieli/ai-agent-book): 《深入理解 AI Agent》 (In-Depth Understanding of AI Agents) by 李博杰 (Bojie Li), Apache-2.0. Chapter 6 is the basis for the evaluation section.
- [tej.as · What is an agent harness](https://tej.as/blog/what-is-an-agent-harness): An introductory explainer on what an agent harness is.
- [Harnesses in AI: A Deep Dive](https://ai.engineer/talks/C_GG5g38vLU-ai-agent-harnesses): Talk by Tejas Kumar (AI Engineer Europe 2026). Shows how guardrails, context management, and verification make an unreliable browser agent reliable without changing its prompt.
- [Total Recall: Agent Memory and Harness Engineering](https://ai.engineer/talks/xs-ob87TTzg-total-recall-agent-memory-harness-engineering): Workshop by Ignacio Martinez, Oracle (AI Engineer World's Fair 2026). Covers memory, retrieval, context assembly, and bounded agent loops around a frozen model.
