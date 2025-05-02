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