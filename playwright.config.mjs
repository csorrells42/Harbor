import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:'electron.spec.mjs',timeout:60000,expect:{timeout:30000},workers:1,reporter:'list',use:{trace:'retain-on-failure'},outputDir:'test-results'});
