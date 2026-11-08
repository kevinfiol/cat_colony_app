challenge:
```md
be brief and concise from now on. read this challenge:

```
challenge: Cat colony updates scattered across chats and photos

It hurts Mangrove Mews' founder, volunteers and cats. Sorting each colony's updates out of WhatsApp messages, photos and shared locations takes hours every week, and urgent cases get missed. Solved means anyone at the rescue sees each colony's state and needs the same day.
Hide details

Mangrove Mews Cat Rescue is made up. Its problem is real, from our survey of 14 South Florida nonprofits.

Beatriz, founder of Mangrove Mews: I started Mangrove Mews six years ago and run it after my day job, with 20 volunteers and feeders. We care for 18 street cat colonies across Miami. Every day my phone fills up: a feeder texts about a new gray cat behind the laundromat, a volunteer sends photos of a limping calico, someone shares a location for a box of kittens. It all has to be recorded: which cats are fixed, which still need TNR (trap, neuter, return), who's sick, and who feeds each colony.

Instead it lives in group chats, my camera roll, a notebook and a spreadsheet only I understand. Two volunteers photograph the same cat, and we count her twice. A pregnant cat's photo sinks under 200 messages, and she gives birth before we can trap her. Sorting it all takes me hours every week, and when a sponsor asks how many cats we've fixed, I can only guess.

I just want anyone on my team to know, the same day, how each colony is doing and what it needs.

What a fix must respect:

    Free, or close to it. Mangrove Mews has no budget for software and no office staff, so it has to be simple enough to run without technical help.
    Volunteers and feeders report from their phones, out on the street, in a minute or two.
    Colony locations, and feeders' names and phone numbers, are seen only by the rescue's own people.
    A person at the rescue confirms before two cats' records are merged, or before a cat is marked adopted or missing.
    Don't automate WhatsApp to pull messages out of a live chat: WhatsApp's terms forbid automated access in ways it hasn't authorized. A chat saved with WhatsApp's Export chat option works, and so do messages volunteers send on purpose.
    For this hackathon, use only made-up messages, photos and locations, never real ones.

What solved looks like: a judge can see these in your demo.

    A feeder's message, photo and shared location, sent from a phone, update the right colony and the right cat, with nobody retyping them.
    Each colony's current state is clear: its number of cats, how many are fixed and how many are still waiting for TNR, which ones need a vet, and who fed them last and when.
    The same cat, photographed by two volunteers, is counted once.
    Urgent cases stand out the same day: a pregnant or injured cat, new kittens, or a colony that has lost its feeder.

Ideas, not requirements:

    At minimum, turn a made-up batch of chat messages, photos, shared locations and volunteer notes into a census of each colony and each cat, working end to end.
    As a stretch, an agent that keeps the census current as new messages arrive, plus reports the rescue can hand to sponsors or the city.
    Features that might help: a map of the colonies, a profile for each cat with its photo and history, and a log of each feeder's visits.
```

ideas from chat with claude:
```
Read it. The core:

**Goal:** Turn feeder updates (messages, photos, locations) into a live census per colony and per cat, visible to the team the same day.

**Must show in demo:**
- A phone report updates the right colony and cat automatically.
- Colony view: cat count, fixed vs. awaiting TNR, vet needs, last feeder and time.
- The same cat photographed twice is counted once.
- Urgent cases flagged: pregnant, injured, kittens, or no feeder.

**Constraints:**
- Free and simple to run.
- Report from a phone in under 2 minutes.
- Locations and feeder contacts stay private.
- A human confirms merges and adopted/missing status.
- No WhatsApp scraping; exported chats or deliberate sends only.
- Made-up data only.

**Core idea: "Text the cat line."** Each volunteer gets their own chat link (`/chat/<uuid>`) in place of WhatsApp. They send whatever they'd normally send; an agent turns it into census updates.

**Reporters: zero friction**
- No app, form, or login. Send a photo, location pin, text, or voice note. Their chat link is their ID.
- A location pin maps to the nearest colony automatically.
- Vision reads coat, ear-tip (meaning already fixed), pregnancy, limp, kittens.
- Voice notes get transcribed, in English or Spanish.
- A one-line reply confirms: "Logged: limping calico, Laundromat colony → vet list." The bot asks only when unsure, using tap buttons.
- Old history comes in once, from an exported chat.

**Founder: near-zero maintenance**
- One dashboard, rescue-only login: colony cards, urgent list, review queue.
- Beatriz texts "today" and gets a digest of urgent cases and pending approvals.
- A watchdog job flags colonies with no feeding logged in X hours.
- Admin happens by chat, e.g. "add volunteer Maria 305…".
- Hosted on free tiers, no servers. A small model keeps API costs low.

**Agents SDK shape**
- An intake agent uses tools: `find_colony`, `match_cat`, `log_sighting`, `log_feeding`, `flag_urgent`.
- `merge_cats`, `mark_adopted` and `mark_missing` require approval. Approvals pause the run until a person approves or rejects the action.
- An output guardrail stops locations and phone numbers from reaching anyone outside the team.
- Codex builds the code, the fake dataset and the tests.

**Dedup:** match a cat only within the same colony, by photo and markings. A confident match logs as the same cat; an unsure one goes to the review queue.
```
