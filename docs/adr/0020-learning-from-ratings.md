# ADR 0020: Learning from customer ratings

Status: accepted (2026-10-01)

## Context

Ratings (ADR 0019) were only reported. The product owner asked for them to feed back into how the agents perform, as a self-learning loop.

A loop that rewrites the AI's behaviour from customer input by itself is unsafe: a rating comment is text an outsider controls, and "learning" from it is prompt injection with extra steps. It is also unaccountable: nobody could say why the AI started answering differently.

## Decision

Two rules:

1. **By itself, the system only makes the AI more careful.** It never widens what the AI may do or changes what it says.
2. **What the AI says changes only through a person**: a lesson written by staff, or a knowledge base article approved by staff. Customers' comments are shown to reviewers and never given to the AI.

**The loop**

- **Feedback.** When a customer rates a ticket the AI worked on, the worker stores what the rating says about the AI: the rating, who had the ticket, its category, and the knowledge base documents the AI's sent answers cited (`ai_feedback`).
- **Automatic caution.** Over the last 90 days, a category or a document whose AI-alone answers have at least 3 ratings averaging 2.5 or lower is "rated badly". An answer on that topic, or citing that document, that the AI would have sent is drafted for a person instead (rule `poor_feedback`; on a voice call it is handed over). The reason is recorded on the run and shown to the agent. It ends by itself when ratings improve or age out.
- **Reviews.** Two kinds of rated tickets are put in front of a reviewer (Orbit Desk → Learning, permission `learning:manage`, supervisors and admins):
  - the AI answered alone and was rated 1 or 2;
  - the AI passed the ticket on and the person's answer was rated 4 or 5: knowledge the AI could have had.
- **Outcomes.** The reviewer writes a lesson, saves the answer as a knowledge base draft (it still needs approval there), or closes the review with nothing to change.
- **Lessons** are short staff-written instructions, for every ticket or one category. Up to 6 active lessons go into the agent's prompt in their own block (prompt `agent-v3`), below the rules, which they never override.
- **Measuring it.** The Learning page shows the AI's own rating for the last 30 days against the 30 before, week by week, next to open reviews, active lessons and what is held back. Reports show ratings per agent next to the AI's, for coaching.
- One switch, Settings → AI behaviour → "Learn from customer ratings", turns lessons and caution off.

**For people**, ratings are a coaching measure only: Reports → Ratings by agent. Nothing is automated on a person's ratings.

## Consequences

- The AI improves at the speed reviewers work. That is deliberate.
- A few unhappy customers can make the AI ask a person first on a topic for up to 90 days. The cost is slower answers, never wrong ones.
- Lessons are matched by category, newest first, capped at 6 per turn. With many lessons a relevance search would be needed.
- A lesson is trusted text in the prompt. `learning:manage` should be given to people who would be trusted to brief a new colleague.
- With the scripted test model, a lesson is followed only in the form "When customers ask about X, tell them: Y". Real models read lessons as written.
