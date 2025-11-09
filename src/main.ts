import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export async function main(): Promise<void> {
  try {
    core.info('Starting k0s setup...');
    
    // Set state to indicate this is not post-run
    core.saveState('isPost', 'true');
    
    // Get inputs
    const version = core.getInput('version') || 'latest';
    const waitForReady = core.getInput('wait-for-ready') === 'true';
    const timeout = parseInt(core.getInput('timeout') || '300', 10);
    
    core.info(`Configuration: version=${version}, wait-for-ready=${waitForReady}, timeout=${timeout}s`);
    
    // Step 1: Install k0s binary
    await installK0s(version);
    
    // Step 2: Start k0s as a controller
    await startK0s();
    
    // Step 3: Wait for cluster ready (if requested)
    if (waitForReady) {
      await waitForClusterReady(timeout);
    }
    
    core.info('✓ k0s setup completed successfully!');
  } catch (error) {
    throw error;
  }
}

async function installK0s(version: string): Promise<void> {
  core.startGroup('Installing k0s');
  
  try {
    core.info(`Installing k0s ${version}...`);
    
    // Detect architecture
    const archOutput: string[] = [];
    await exec.exec('uname', ['-m'], {
      listeners: {
        stdout: (data: Buffer) => archOutput.push(data.toString())
      }
    });
    const arch = archOutput.join('').trim();
    
    // Map architecture to binary name
    let binaryArch: string;
    switch (arch) {
      case 'x86_64':
        binaryArch = 'amd64';
        break;
      case 'aarch64':
      case 'arm64':
        binaryArch = 'arm64';
        break;
      case 'armv7l':
        binaryArch = 'arm';
        break;
      default:
        throw new Error(`Unsupported architecture: ${arch}`);
    }
    
    core.info(`  Architecture: ${arch} -> ${binaryArch}`);
    
    // Resolve version if 'latest'
    let actualVersion = version;
    if (version === 'latest') {
      core.info('Resolving latest version...');
      const versionOutput: string[] = [];
      await exec.exec('bash', ['-c', 'curl -sL https://api.github.com/repos/k0sproject/k0s/releases/latest | grep \'"tag_name"\' | cut -d\'"\' -f4'], {
        listeners: {
          stdout: (data: Buffer) => versionOutput.push(data.toString())
        }
      });
      actualVersion = versionOutput.join('').trim();
      core.info(`  Latest version: ${actualVersion}`);
    }
    
    // Construct download URL
    const downloadUrl = `https://github.com/k0sproject/k0s/releases/download/${actualVersion}/k0s-${actualVersion}-${binaryArch}`;
    
    core.info(`  Downloading from: ${downloadUrl}`);
    
    // Download binary
    const tmpBinary = '/tmp/k0s';
    await exec.exec('curl', ['-sfL', downloadUrl, '-o', tmpBinary]);
    
    // Install binary
    core.info('  Installing binary to /usr/local/bin/k0s...');
    await exec.exec('sudo', ['install', tmpBinary, '/usr/local/bin/k0s']);
    
    // Clean up
    await exec.exec('rm', ['-f', tmpBinary]);
    
    // Verify installation
    core.info('  Verifying installation...');
    await exec.exec('k0s', ['version']);
    
    core.info('✓ k0s installed successfully');
  } catch (error) {
    throw new Error(`Failed to install k0s: ${error}`);
  } finally {
    core.endGroup();
  }
}

async function startK0s(): Promise<void> {
  core.startGroup('Starting k0s cluster');
  
  try {
    core.info('Starting k0s as controller...');
    
    // Install k0s as a controller service
    await exec.exec('sudo', ['k0s', 'install', 'controller', '--single']);
    
    // Start k0s service
    await exec.exec('sudo', ['k0s', 'start']);
    
    // Wait a moment for kubeconfig to be generated
    core.info('  Waiting for kubeconfig generation...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Get kubeconfig from k0s
    const kubeconfigDir = path.join(os.homedir(), '.kube');
    const kubeconfigPath = path.join(kubeconfigDir, 'config');
    
    // Create .kube directory if it doesn't exist
    try {
      await fs.mkdir(kubeconfigDir, { recursive: true });
    } catch (error) {
      // Directory already exists
    }
    
    // Extract kubeconfig from k0s
    core.info('  Extracting kubeconfig...');
    const kubeconfigContent: string[] = [];
    await exec.exec('sudo', ['k0s', 'kubeconfig', 'admin'], {
      listeners: {
        stdout: (data: Buffer) => kubeconfigContent.push(data.toString())
      }
    });
    
    // Write kubeconfig
    await fs.writeFile(kubeconfigPath, kubeconfigContent.join(''));
    await exec.exec('chmod', ['600', kubeconfigPath]);
    
    // Export KUBECONFIG environment variable
    core.setOutput('kubeconfig', kubeconfigPath);
    core.exportVariable('KUBECONFIG', kubeconfigPath);
    core.info(`  KUBECONFIG exported: ${kubeconfigPath}`);
    
    core.info('✓ k0s cluster started successfully');
  } catch (error) {
    throw new Error(`Failed to start k0s: ${error}`);
  } finally {
    core.endGroup();
  }
}

async function waitForClusterReady(timeoutSeconds: number): Promise<void> {
  core.startGroup('Waiting for cluster ready');
  
  try {
    core.info(`Waiting for k0s cluster to be ready (timeout: ${timeoutSeconds}s)...`);
    
    const startTime = Date.now();
    
    while (true) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      
      if (elapsed > timeoutSeconds) {
        core.error('Timeout waiting for cluster to be ready');
        await showDiagnostics();
        throw new Error('Timeout waiting for cluster to be ready');
      }
      
      // Check k0s status
      const statusResult = await exec.exec('sudo', ['k0s', 'status'], { 
        ignoreReturnCode: true,
        silent: true 
      });
      
      if (statusResult === 0) {
        core.info('  k0s is running');
        
        // Check if kubectl can connect to API server
        const kubectlResult = await exec.exec('kubectl', ['cluster-info'], {
          ignoreReturnCode: true,
          silent: true
        });
        
        if (kubectlResult === 0) {
          core.info('  kubectl can connect to API server');
          
          // Check if all nodes are Ready
          const nodesReady = await exec.exec('bash', ['-c', 
            'kubectl get nodes --no-headers | grep -v " Ready "'
          ], {
            ignoreReturnCode: true,
            silent: true
          });
          
          if (nodesReady !== 0) {
            core.info('  All nodes are Ready');
            
            // Check if core pods are running
            const podsRunning = await exec.exec('bash', ['-c',
              'kubectl get pods -n kube-system --no-headers | grep -v "Running\\|Completed"'
            ], {
              ignoreReturnCode: true,
              silent: true
            });
            
            if (podsRunning !== 0) {
              core.info('  All kube-system pods are running');
              break;
            } else {
              core.info('  Some kube-system pods not running yet');
            }
          } else {
            core.info('  Some nodes not Ready yet');
          }
        } else {
          core.info('  kubectl cannot connect yet');
        }
      } else {
        core.info('  k0s not running yet');
      }
      
      core.info(`  Cluster not ready yet, waiting... (${elapsed}/${timeoutSeconds}s)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    core.info('✓ k0s cluster is fully ready!');
  } catch (error) {
    throw new Error(`Failed waiting for cluster: ${error}`);
  } finally {
    core.endGroup();
  }
}

async function showDiagnostics(): Promise<void> {
  core.startGroup('Diagnostic Information');
  
  try {
    core.info('=== k0s Status ===');
    await exec.exec('sudo', ['k0s', 'status'], { ignoreReturnCode: true });
    
    core.info('=== k0s Controller Logs ===');
    await exec.exec('sudo', ['journalctl', '-u', 'k0scontroller', '-n', '100', '--no-pager'], { ignoreReturnCode: true });
    
    core.info('=== Kubectl Cluster Info ===');
    await exec.exec('kubectl', ['cluster-info'], { ignoreReturnCode: true });
    
    core.info('=== Nodes ===');
    await exec.exec('kubectl', ['get', 'nodes', '-o', 'wide'], { ignoreReturnCode: true });
    
    core.info('=== Kube-system Pods ===');
    await exec.exec('kubectl', ['get', 'pods', '-n', 'kube-system'], { ignoreReturnCode: true });
  } catch (error) {
    core.warning(`Failed to gather diagnostics: ${error}`);
  } finally {
    core.endGroup();
  }
}
