# Phase 10b demo checklist: learning from ratings

Prerequisites: `pnpm docker:up && pnpm sample:load`. Sign in to Orbit Desk (http://localhost:8081) as the supervisor `priya.natarajan@tms.example` (`Sample-Passw0rd!`) and open **Learning**.

## What the page shows

1. Four figures: the rating of the AI's own tickets (and how it moved), reviews waiting, lessons the AI follows, and what is held back.
2. **To review** has two sample tickets:
   - TMS-45: the AI's answer was rated 2, with the customer's comment.
   - TMS-41: the AI passed the chat on and Jonah's answer was rated 5.
3. **Lessons** has one sample lesson about gift card refunds.

## A low rating becomes a lesson

1. On TMS-45 click **Write a lesson**. Type, in your own words: "When customers ask about refunds for opened helmets, tell them: Opened helmets can be returned within 30 days if they are unused."
2. Choose **Every ticket** and save. The review leaves the list; the lesson shows where it came from and who wrote it.
3. On http://localhost:8080/widget/demo.html ask "Can I get a refund for an opened helmet?". The AI answers as the lesson says.
4. **Switch off** the lesson and ask again: the AI is back to the knowledge base answer.

## A good answer becomes knowledge

1. On TMS-41 click **Add to knowledge base**. The question and Jonah's answer are filled in; remove anything personal and save.
2. Open **Knowledge base**: the entry is there as a draft. The AI uses it once someone approves it.

## The AI gets careful by itself

1. Ask the same question in three separate chats (new private windows), let the AI answer, resolve each ticket and rate each 1 in the chat.
2. **Learning → Where the AI asks a person first** now names the document those answers used.
3. Ask again in a fourth chat: the ticket shows a draft marked "Customers rated answers like this one badly", waiting for an agent to approve.
4. To undo it for the demo, rate later tickets well, or switch **Learn from customer ratings** off under Settings → AI behaviour.

## For people

**Reports → Ratings by agent** lists each agent's ratings next to the AI's. It is for coaching: nothing happens automatically on a person's ratings.
