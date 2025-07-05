## 0.7.5 (2025-07-05)

This was a version bump only, there were no code changes.

## 0.7.4 (2025-07-05)

### 🚀 Features

- add validator handler and run before process ([5a43b15](https://github.com/torotask/torotask/commit/5a43b15))

### 🩹 Fixes

- **tester:** update tester app with correct batch handling ([694d6c3](https://github.com/torotask/torotask/commit/694d6c3))

### ❤️ Thank You

- Ben Osman @benosman

## 0.7.3 (2025-07-04)

### 🩹 Fixes

- **task:** ensure task worker options get passed to worker ([21151cb](https://github.com/torotask/torotask/commit/21151cb))

### ❤️ Thank You

- Ben Osman @benosman

## 0.7.2 (2025-07-04)

### 🚀 Features

- enable clients to subscribe to active events ([d9311ab](https://github.com/torotask/torotask/commit/d9311ab))

### 🩹 Fixes

- store payload rather than data for events ([ff8695e](https://github.com/torotask/torotask/commit/ff8695e))

### ❤️ Thank You

- Ben Osman @benosman

## 0.7.1 (2025-07-03)

### 🩹 Fixes

- **steps:** ensure typing works with runTasks ([8c00f4c](https://github.com/torotask/torotask/commit/8c00f4c))

### ❤️ Thank You

- Ben Osman @benosman

## 0.7.0 (2025-07-01)

### 🚀 Features

- allow payload type to be inferred from schema ([5ba1072](https://github.com/torotask/torotask/commit/5ba1072))
- add typing to step.runTask via helper function ([e87dc7a](https://github.com/torotask/torotask/commit/e87dc7a))
- add jobById method for client ([22cb2d2](https://github.com/torotask/torotask/commit/22cb2d2))
- add client property to step executor ([744ad31](https://github.com/torotask/torotask/commit/744ad31))
- **client:** adjust all classes to use TaskJob’s payload and state ([df3aa08](https://github.com/torotask/torotask/commit/df3aa08))
- **client:** add new stepExecutor class ([7024c94](https://github.com/torotask/torotask/commit/7024c94))
- **client:** add datetime and duration helpers for tasks and steps ([7b6fa15](https://github.com/torotask/torotask/commit/7b6fa15))
- **client:** set taskClient and task on job if possible ([68d8762](https://github.com/torotask/torotask/commit/68d8762))
- **flow:** add typing for Flows ([613ae22](https://github.com/torotask/torotask/commit/613ae22))
- **schema:** add helper function for creating schema ([b151132](https://github.com/torotask/torotask/commit/b151132))
- **server:** adjust all classes to use TaskJob’s payload and state ([ff08d20](https://github.com/torotask/torotask/commit/ff08d20))
- **step:** add startGroupTask method ([beb0c2c](https://github.com/torotask/torotask/commit/beb0c2c))
- **steps:** ensure job instances are memoized safely and  are compact ([4bc3866](https://github.com/torotask/torotask/commit/4bc3866))
- **steps:** add runTasks (bulk) support ([b7dd0a2](https://github.com/torotask/torotask/commit/b7dd0a2))
- **task:** relay worker queue events on base task ([4a78afb](https://github.com/torotask/torotask/commit/4a78afb))
- **task:** get payload type inferral working ([7618036](https://github.com/torotask/torotask/commit/7618036))
- **task:** add option to skip schema validation ([d35f9e3](https://github.com/torotask/torotask/commit/d35f9e3))
- **task-group:** allow task creation in constructor ([7e7acde](https://github.com/torotask/torotask/commit/7e7acde))
- **task-group:** add typed runTask ([3227aca](https://github.com/torotask/torotask/commit/3227aca))
- **task-groups:** add task group registry ([a8c7b75](https://github.com/torotask/torotask/commit/a8c7b75))
- **task-groups:** add typing for tasks in task groups ([11a920d](https://github.com/torotask/torotask/commit/11a920d))
- **task-run:** create task-run class, a proxy around job ([b46d80b](https://github.com/torotask/torotask/commit/b46d80b))
- **tasks:** add/improve helper methods for task groups ([96a9bd9](https://github.com/torotask/torotask/commit/96a9bd9))

### 🩹 Fixes

- resolve type issues around job and worker process ([0685230](https://github.com/torotask/torotask/commit/0685230))
- make sure job date (payload, state) is getting added correctly ([a9ead78](https://github.com/torotask/torotask/commit/a9ead78))
- better error handling for step execution ([c058d07](https://github.com/torotask/torotask/commit/c058d07))
- simplify WaitForChildren error ([60ebe8b](https://github.com/torotask/torotask/commit/60ebe8b))
- simplify error handling in steps, use native BullMQ errors ([6271a84](https://github.com/torotask/torotask/commit/6271a84))
- swap logger.info for logger.debug, make it less verbose ([a7f0dca](https://github.com/torotask/torotask/commit/a7f0dca))
- **client:** resolve uncompleted batch child jobs due to not passing back promise ([480c947](https://github.com/torotask/torotask/commit/480c947))
- **client:** don’t use task.name for job name as that is the queue ([790a8a3](https://github.com/torotask/torotask/commit/790a8a3))
- **client:** get step executor to mostly working state ([695197e](https://github.com/torotask/torotask/commit/695197e))
- **client:** remove waiting for event status ([f2cbfe8](https://github.com/torotask/torotask/commit/f2cbfe8))
- **queue:** cast JobOptions, since they are converted later. ([07bed34](https://github.com/torotask/torotask/commit/07bed34))
- **server:** make sure schema gets passed in during creation ([1602102](https://github.com/torotask/torotask/commit/1602102))
- **server:** make sure unhandledExceptions are caught by server. ([f695cea](https://github.com/torotask/torotask/commit/f695cea))
- **steps:** resolve issues with step run task function typing ([de7f8c7](https://github.com/torotask/torotask/commit/de7f8c7))
- **task:** update defineTask to work with new schema inferred payload ([549f282](https://github.com/torotask/torotask/commit/549f282))
- **task:** make sure trigger payloads don’t affect handler payload. ([4486604](https://github.com/torotask/torotask/commit/4486604))
- **task:** remove partial from trigger payload ([d6f7ccb](https://github.com/torotask/torotask/commit/d6f7ccb))
- **task:** prevent task from failing for allowed control errors. ([98cea17](https://github.com/torotask/torotask/commit/98cea17))
- **task-groups:** store the tasks by key and id correctly ([6154839](https://github.com/torotask/torotask/commit/6154839))
- **tasks:** fix type checking on taskGroup.tasks ([0631990](https://github.com/torotask/torotask/commit/0631990))

### ❤️ Thank You

- Ben Osman @benosman

## 0.6.0 (2025-05-02)

### 🚀 Features

- **client:** add bulk tasks / flow producer suport ([8dfc65b](https://github.com/torotask/torotask/commit/8dfc65b))
- **client:** pass token through to process ([e85d902](https://github.com/torotask/torotask/commit/e85d902))

### ❤️ Thank You

- Ben Osman @benosman

## 0.5.2 (2025-04-30)

### 🩹 Fixes

- **client:** add event trigger data to event process ([ef8399d](https://github.com/torotask/torotask/commit/ef8399d))

### ❤️ Thank You

- Ben Osman @benosman

## 0.5.1 (2025-04-25)

This was a version bump only, there were no code changes.

## 0.5.0 (2025-04-25)

### 🚀 Features

- **client:** add first steps for batch task ([becbd73](https://github.com/torotask/torotask/commit/becbd73))
- **client:** Add worker options into taskOptions, so defaults can be set using definitions ([599fb8a](https://github.com/torotask/torotask/commit/599fb8a))

### 🩹 Fixes

- **client:** set default concurrency for batch tasks to match batchSize ([029079b](https://github.com/torotask/torotask/commit/029079b))
- **client:** make sure batch timeout is required option ([65dc6d1](https://github.com/torotask/torotask/commit/65dc6d1))

### ❤️ Thank You

- Ben Osman @benosman

## 0.4.0 (2025-04-17)

### 🚀 Features

- **client:** add activeEvents cache, and skip queue if not present ([ff7136f](https://github.com/torotask/torotask/commit/ff7136f))
- **client:** add run tasks method for consumers ([66a86c3](https://github.com/torotask/torotask/commit/66a86c3))
- **client:** add runTaskByKey and getTaskByKey helpers ([d06b33d](https://github.com/torotask/torotask/commit/d06b33d))

### 🩹 Fixes

- **client:** update process function to work with new event subscriptions ([753f4d0](https://github.com/torotask/torotask/commit/753f4d0))

### ❤️ Thank You

- Ben Osman @benosman

## 0.3.1 (2025-04-16)

### 🩹 Fixes

- **client:** make sure getConfigFromEnv returns nested maps ([2054065](https://github.com/torotask/torotask/commit/2054065))

### ❤️ Thank You

- Ben Osman @benosman

## 0.3.0 (2025-04-16)

### 🚀 Features

- **client:** allow passing in env vars to client ([d7d3c6e](https://github.com/torotask/torotask/commit/d7d3c6e))

### ❤️ Thank You

- Ben Osman @benosman

## 0.2.1 (2025-04-16)

### 🩹 Fixes

- **client:** rename env vars for ToroTask ([d6564a0](https://github.com/torotask/torotask/commit/d6564a0))

### ❤️ Thank You

- Ben Osman @benosman

## 0.2.0 (2025-04-15)

### 🚀 Features

- **client:** add overridable redis prefix ([6a0d9de](https://github.com/torotask/torotask/commit/6a0d9de))

### 🩹 Fixes

- **dashboard:** set delimiter for tasks ([1c54901](https://github.com/torotask/torotask/commit/1c54901))

### ❤️ Thank You

- Ben Osman @benosman

## 0.1.0 (2025-04-15)

### 🚀 Features

- add torotask package ([da61f16](https://github.com/torotask/torotask/commit/da61f16))
- **client:** add client package ([605985b](https://github.com/torotask/torotask/commit/605985b))
- **client:** add runAndWait function ([0432daf](https://github.com/torotask/torotask/commit/0432daf))
- **client:** add pino logging to client instance ([a9b6a1e](https://github.com/torotask/torotask/commit/a9b6a1e))
- **client:** add options and context to function handlers ([a17e369](https://github.com/torotask/torotask/commit/a17e369))
- **client:** pass job through to job process ([3bcf932](https://github.com/torotask/torotask/commit/3bcf932))
- **client:** add worker to task ([2683d52](https://github.com/torotask/torotask/commit/2683d52))
- **client:** add subtask ([0d8983d](https://github.com/torotask/torotask/commit/0d8983d))
- **client:** track all queues ([4f458a8](https://github.com/torotask/torotask/commit/4f458a8))
- **client:** add start and stop workers methods ([401c096](https://github.com/torotask/torotask/commit/401c096))
- **client:** add event listeners to base queue ([5bb3c30](https://github.com/torotask/torotask/commit/5bb3c30))
- **client:** add get queue instances function to client ([19fdabe](https://github.com/torotask/torotask/commit/19fdabe))
- **client:** Add catch all option and handle job when name is empty / default ([9e4a471](https://github.com/torotask/torotask/commit/9e4a471))
- **client:** add trigger parameter ([bb23fc5](https://github.com/torotask/torotask/commit/bb23fc5))
- **client:** add scheduler management ([64d317c](https://github.com/torotask/torotask/commit/64d317c))
- **client:** allow changes to options and scheduler ([cbf98d9](https://github.com/torotask/torotask/commit/cbf98d9))
- **client:** add optional trigger name with fallback ([e7a0fae](https://github.com/torotask/torotask/commit/e7a0fae))
- **client:** add event dispatcher stub ([02fffb2](https://github.com/torotask/torotask/commit/02fffb2))
- **client:** add redisClient method to base queue ([3a95a47](https://github.com/torotask/torotask/commit/3a95a47))
- **client:** add event dispatcher ([e384d8a](https://github.com/torotask/torotask/commit/e384d8a))
- **client:** add helper functions to event dispatcher ([2355020](https://github.com/torotask/torotask/commit/2355020))
- **client:** add getDefaultOptions method to base queue ([eb76da0](https://github.com/torotask/torotask/commit/eb76da0))
- **client:** add event manager class ([a9e6b2d](https://github.com/torotask/torotask/commit/a9e6b2d))
- **dashboard:** add simple dashboard ([e08c971](https://github.com/torotask/torotask/commit/e08c971))
- **dashboard:** use new queue list methods ([4c19e75](https://github.com/torotask/torotask/commit/4c19e75))
- **dashboard:** update queue list ([2a0a331](https://github.com/torotask/torotask/commit/2a0a331))
- **server:** add server package ([00de1e3](https://github.com/torotask/torotask/commit/00de1e3))
- **server:** add loadTasksFromDirectory helper ([52445d0](https://github.com/torotask/torotask/commit/52445d0))
- **server:** support rootDir option for setting task root ([837cd9e](https://github.com/torotask/torotask/commit/837cd9e))
- **server:** add factory function to define task ([edd35e4](https://github.com/torotask/torotask/commit/edd35e4))
- **tester:** add simple test app ([c5f7ee4](https://github.com/torotask/torotask/commit/c5f7ee4))

### 🩹 Fixes

- update tasks to work with new options ([958f0d6](https://github.com/torotask/torotask/commit/958f0d6))
- **client:** get event manager register/unregister functionality working ([a974ff0](https://github.com/torotask/torotask/commit/a974ff0))
- **server:** make clientOptions optional ([18958bc](https://github.com/torotask/torotask/commit/18958bc))
- **tester:** fix import in task ([15fe4d1](https://github.com/torotask/torotask/commit/15fe4d1))

### ❤️ Thank You

- Ben Osman @benosman