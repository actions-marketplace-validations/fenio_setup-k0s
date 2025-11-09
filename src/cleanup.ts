import * as core from '@actions/core';
import * as exec from '@actions/exec';

export async function cleanup(): Promise<void> {
  core.startGroup('Cleaning up k0s');
  
  try {
    core.info('Starting cleanup...');
    
    // Stop and reset k0s cluster
    await stopK0s();
    
    core.info('✓ k0s cleanup complete');
  } catch (error) {
    core.warning(`Cleanup encountered errors: ${error}`);
    // Don't fail the workflow if cleanup has issues
  } finally {
    core.endGroup();
  }
}

async function stopK0s(): Promise<void> {
  core.info('Stopping k0s cluster...');
  
  // Check if k0s is installed
  const isInstalled = await exec.exec('which', ['k0s'], { 
    ignoreReturnCode: true,
    silent: true 
  });
  
  if (isInstalled !== 0) {
    core.info('  k0s not installed, skipping cleanup');
    return;
  }
  
  // Stop k0s service
  core.info('  Stopping k0s service...');
  await exec.exec('sudo', ['k0s', 'stop'], { ignoreReturnCode: true });
  
  // Reset k0s (removes all data and configuration)
  core.info('  Resetting k0s...');
  await exec.exec('sudo', ['k0s', 'reset'], { ignoreReturnCode: true });
  
  core.info('  k0s cluster stopped and reset');
}
