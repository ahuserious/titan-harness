# Content presets

A preset names one kind of content for one industry and one preference profile, and the
rubric and the human reviewers it needs before an agent may re-review it (plan §5.6, tier
`content`). Project presets live in `.titan/presets/content/<key>.yaml` and shadow the
package copies here (`.pi/titan-harness/presets/content/`) by `key`.

```yaml
key: saas-blog-post-founder            # ^[a-z0-9][a-z0-9-]{0,79}$ — <industry>-<content-type>-<user-preference>
industry: saas
content_type: blog-post
preference_profile:
  voice: founder, first person
  tone: direct, no hype
  banned_claims: ["guaranteed", "the best", "#1"]
  style_guide_ref: .titan/terraform/style.md
rubric:
  - { criterion: accuracy, threshold: 4 }
  - { criterion: clarity, threshold: 4 }
  - { criterion: brand-fit, threshold: 3 }
reviewers:
  human_min: 3                          # distinct human approve receipts before an agent re-review may ship
  roles: [editor, founder, legal]
receipts_dir: receipts/saas-blog-post-founder   # optional; relative to the run's artifacts dir
```

How receipts work: an `approval:` node with `preset_key: <key>` records one
`approval-receipt` artifact per decision under `<artifacts>/receipts/<key>/<contentSha256>-<n>.json`
(`{presetKey, reviewer, decision, rubricScores, ts, contentSha256}`). The content hashed is
`approval.content` (for example `$draft.output`), else the message itself. The reply may name
the reviewer and score the rubric: `reviewer: Dana; accuracy=5, clarity=4`. The node's output is
`{approved, receipts, required, presetKey, contentSha256}` where `receipts` counts distinct
approve receipts for that content hash, so a ship node gates on
`when: "$approve-3.output.receipts >= 3"`; fewer receipts skip the ship node, never prose.
Agent re-review runs only after the third receipt (a `role: judge` node after the gate).
