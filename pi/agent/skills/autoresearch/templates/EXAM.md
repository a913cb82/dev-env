# EXAM (copy to the run dir and fill every TODO)

- target: TODO one folder explorers may change
- frozen: TODO paths nobody edits, space-separated
- gate: TODO fast pass/fail command, prints no score
- exam: TODO scored command; last line `SCORE <number>`, exit 0
- direction: TODO higher or lower is better
- inputs: TODO fixed inputs for baseline and every candidate
- holdout: TODO scored command on unseen inputs
- explorers: TODO max parallel explorers (1 runs serially)
- explorer budget: TODO hard coding time limit per explorer, e.g. 30m
- candidate budget: TODO max returned explorers before spawning stops
- min gain: TODO smallest gain worth keeping
- margin: TODO max(noise, min gain); fill in at setup
- baseline: TODO mean of 3 runs, date, commit
- noise: TODO max minus min of the baseline runs
