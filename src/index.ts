import * as core from '@actions/core';
import { main } from './main';
import { cleanup } from './cleanup';

async function run(): Promise<void> {
  try {
    const isPost = core.getState('isPost');
    
    if (isPost === 'true') {
      // This is the post-run cleanup phase
      await cleanup();
    } else {
      // This is the main setup phase
      await main();
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
