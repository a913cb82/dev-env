# EXAM (copy to the run dir and fill every TODO)

- target: TODO one folder explorers may change
- blocks: TODO optional marked regions narrowing target, e.g. #EVOLVE-BLOCK; blank = whole target
- frozen: TODO paths nobody edits, space-separated
- gate: TODO staged cheap checks in order, stop at first fail; stages may parallelize internally
- exam: TODO scoring command; last line `SCORE <number>`, extra `SCORE <name> <number>` lines allowed; qualitative / model-graded checks fold into scores; must tolerate concurrent runs (unique tmp/ports)
- direction: TODO higher or lower is better (primary score)
- inputs: TODO fixed inputs for baseline and every candidate; unit may be a search program with time budget + best-so-far input
- holdout: TODO scored command on unseen inputs
- explorers: TODO max parallel explorers (1 runs serially)
- explorer budget: TODO hard coding time limit per explorer, e.g. 30m
- candidate budget: TODO max returned explorers before spawning stops
- min gain: TODO smallest gain worth keeping
- levels: TODO bulk thinking level + breakthrough every Nth, e.g. low, high every 4th
- margin: TODO max(noise, min gain); fill in at setup
- baseline: TODO mean of 3 runs, date, commit
- noise: TODO max minus min of the baseline runs
