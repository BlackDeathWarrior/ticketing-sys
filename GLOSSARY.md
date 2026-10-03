# Ticketing platform

A helpdesk where customers reach a company over several channels and an AI answers first, with people taking over when needed.

## Language

**Channel**:
The way a customer reaches the company and reads its replies: email, the request form, web chat, WhatsApp, a voice call, or a request page inside another app.
_Avoid_: Medium, source

**Channel traits**:
The fixed facts about how a customer experiences one channel: where they read replies, whether they are waiting live, and which notices reach them. The same for every company; never a setting.
_Avoid_: Channel rules, channel config, channel lists

**Mode**:
A company's choice, per channel, of whether the AI sends its answers by itself, only drafts them for a person, or stays out.
_Avoid_: Channel trait (a mode is chosen; a trait is not)

**Holding message**:
The automatic "a person will reply" sent once to a customer who is waiting live while the AI's draft waits for approval.
_Avoid_: Waiting message, acknowledgement

**Handover notice**:
What a customer is told when the AI passes their conversation to a person.
_Avoid_: Handover message, transfer message

## Relationships

- Every **Channel** has exactly one set of **Channel traits**
- What the AI does on a **Channel** is its **Channel traits** combined with the company's **Mode** for that channel
