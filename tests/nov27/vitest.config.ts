import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/nov27/*.test.ts'],environment:'node',testTimeout:120000,fileParallelism:false}});
