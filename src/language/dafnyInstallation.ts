import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { workspace, ExtensionContext, Uri, OutputChannel, FileSystemError, window } from 'vscode';
import { Utils } from 'vscode-uri';

import got from 'got';
import * as extract from 'extract-zip';

import { ConfigurationConstants, LanguageServerConstants } from '../constants';
import Configuration from '../configuration';
import { exec } from 'child_process';
import { chdir as processChdir, cwd as processCwd } from 'process';

const execAsync = promisify(exec);

const ArchiveFileName = 'dafny.zip';
const mkdirAsync = promisify(fs.mkdir);

// Equivalent to a || b but without ESLint warnings
function ifNullOrEmpty(a: string | null, b: string): string {
  return a === null || a === '' ? b : a;
}

function getConfiguredVersion(): string {
  const version = Configuration.get<string>(ConfigurationConstants.PreferredVersion);
  return version === LanguageServerConstants.Latest
    ? LanguageServerConstants.LatestVersion
    : version;
}

export function isConfiguredToInstallLatestDafny(): boolean {
  return Configuration.get<string>(ConfigurationConstants.PreferredVersion) === LanguageServerConstants.Latest;
}

export function getCompilerRuntimePath(context: ExtensionContext): string {
  const configuredPath = ifNullOrEmpty(
    Configuration.get<string | null>(ConfigurationConstants.Compiler.RuntimePath),
    LanguageServerConstants.GetDefaultCompilerPath(getConfiguredVersion())
  );
  if(!path.isAbsolute(configuredPath)) {
    return path.join(context.extensionPath, configuredPath);
  }
  return configuredPath;
}

export function getLanguageServerRuntimePath(context: ExtensionContext): string {
  const configuredPath = ifNullOrEmpty(
    getConfiguredLanguageServerRuntimePath(),
    LanguageServerConstants.GetDefaultPath(getConfiguredVersion())
  );
  if(path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.join(context.extensionPath, configuredPath);
}

function getConfiguredLanguageServerRuntimePath(): string {
  const languageServerOverride = process.env['DAFNY_SERVER_OVERRIDE'] ?? '';
  if(languageServerOverride) {
    window.showInformationMessage(`Using $DAFNY_SERVER_OVERRIDE = ${languageServerOverride} for the server path`);
  }
  const languageServerSetting = Configuration.get<string | null>(ConfigurationConstants.LanguageServer.RuntimePath) ?? '';
  return languageServerOverride || languageServerSetting;
}

function getDafnyPlatformSuffix(): string {
  switch(os.type()) {
  case 'Windows_NT':
    return 'win';
  case 'Darwin':
    return 'osx-10.14.2';
  default:
    return 'ubuntu-16.04';
  }
}

function getDafnyDownloadAddress(): string {
  const baseUri = LanguageServerConstants.DownloadBaseUri;
  const version = getConfiguredVersion();
  const suffix = getDafnyPlatformSuffix();
  return `${baseUri}/v${version}/dafny-${version}-x64-${suffix}.zip`;
}

export class DafnyInstaller {
  public constructor(
    private readonly context: ExtensionContext,
    private readonly statusOutput: OutputChannel
  ) {}

  public isLatestKnownLanguageServerOrNewer(version: string): boolean {
    if(version === LanguageServerConstants.UnknownVersion) {
      this.writeStatus('failed to resolve the installed Dafny version');
      return true;
    }
    const givenParts = version.split('.');
    const latestVersion = LanguageServerConstants.LatestVersion;
    const latestParts = latestVersion.split('.');
    for(let i = 0; i < Math.min(givenParts.length, latestParts.length); i++) {
      const given = givenParts[i];
      const latest = latestParts[i];
      if(given < latest) {
        this.writeStatus(`the installed Dafny version is older than the latest: ${version} < ${latestVersion}`);
        return false;
      }
      if(given > latest) {
        this.writeStatus(`the installed Dafny version is newer than the latest: ${version} > ${latestVersion}`);
        return true;
      }
    }
    this.writeStatus(`the installed Dafny version is the latest known: ${version} = ${latestVersion}`);
    return true;
  }

  public async install(): Promise<boolean> {
    this.statusOutput.show();
    this.writeStatus('Starting Dafny installation');
    try {
      await this.cleanInstallDir();
      const archive = await this.downloadArchive(getDafnyDownloadAddress());
      await this.extractArchive(archive);
      await workspace.fs.delete(archive, { useTrash: false });
      this.writeStatus('Dafny installation completed');
      if(os.type() === 'Darwin' && os.arch() !== 'x64') {
        // Need to build from source and move all files from Binary/ to the out/resource folder
        this.writeStatus(`Found a non-supported architecture OSX:${os.arch()}. Going to install from source and replace the automated installation.`);
        return await this.installFromSource();
      } else {
        return true;
      }
    } catch(error: unknown) {
      this.writeStatus('Dafny installation failed:');
      this.writeStatus(`> ${error}`);
      console.error('dafny installation failed', error);
      return false;
    }
  }

  private async execLog(command: string): Promise<{ stderr: string, stdout: string }> {
    this.writeStatus(`Executing: ${command}`);
    return await execAsync(command);
  }
  private GetZ3FileNameOSX(): string {
    const z3v = LanguageServerConstants.Z3VersionForCustomInstallation;
    return `z3-${z3v}-x64-osx-10.14.2`;
  }
  private GetZ3DownloadUrlOSX(): string {
    const z3v = LanguageServerConstants.Z3VersionForCustomInstallation;
    const z3filenameOsx = this.GetZ3FileNameOSX();
    return `https://github.com/Z3Prover/z3/releases/download/Z3-${z3v}/${z3filenameOsx}.zip`;
  }

  private async installFromSource() {
    const installationPath = this.getCustomInstallationPath(os.arch());
    await mkdirAsync(installationPath.fsPath, { recursive: true });
    this.writeStatus(`Installing Dafny from source in ${installationPath.fsPath}.\n`);
    const previousDirectory = processCwd();
    processChdir(installationPath.fsPath);
    try {
      await this.execLog('brew install dotnet-sdk');
    } catch(error: unknown) {
      this.writeStatus('If you got `brew: command not found`, but brew is installed on your system, please add all brew commands to your ~/.zprofile, e.g. https://apple.stackexchange.com/a/430904 and reinstall Dafny.');
      return false;
    }
    try {
      const result = (await this.execLog('javac -version')).stdout;
      if(!(/javac \d+\.\d+/.exec(result))) {
        throw '';
      }
    } catch(error: unknown) {
      const errorMsg = error === '' ? 'Javac not found' : `${error}`;
      this.writeStatus(`${errorMsg}. Please install a valid JDK`
       + ' and ensure that the path containing javac is in the PATH environment variable. '
       + 'You can obtain a free open-source JDK 1.8 from here: '
       + 'https://aws.amazon.com/corretto/');
      return false;
    }
    await this.execLog(`git clone --recurse-submodules ${LanguageServerConstants.DafnyGitUrl}`);
    processChdir(Utils.joinPath(installationPath, 'dafny').fsPath);
    await this.execLog('git fetch --all --tags');
    await this.execLog(`git checkout v${getConfiguredVersion()}`);
    await this.execLog('make exe');
    const binaries = Utils.joinPath(installationPath, 'dafny', 'Binaries').fsPath;
    processChdir(binaries);
    await this.execLog('brew install wget');
    const z3urlOsx = this.GetZ3DownloadUrlOSX();
    const z3filenameOsx = this.GetZ3FileNameOSX();
    await this.execLog(`wget ${z3urlOsx}`);
    await this.execLog(`unzip ${z3filenameOsx}.zip`);
    await this.execLog(`mv ${z3filenameOsx} z3`);
    processChdir(this.getInstallationPath().fsPath);
    await this.execLog(`cp -R ${binaries}/* ./dafny/`);
    processChdir(previousDirectory);
    return true;
  }

  public isCustomInstallation(): boolean {
    return getConfiguredLanguageServerRuntimePath() !== '';
  }

  public async isLanguageServerRuntimeAccessible(): Promise<boolean> {
    const languageServerDll = getLanguageServerRuntimePath(this.context);
    try {
      await fs.promises.access(languageServerDll, fs.constants.R_OK);
      return true;
    } catch(error: unknown) {
      return false;
    }
  }

  private async cleanInstallDir(): Promise<void> {
    const installPath = this.getInstallationPath();
    this.writeStatus(`deleting previous Dafny installation at ${installPath.fsPath}`);
    try {
      await workspace.fs.delete(
        installPath,
        {
          recursive: true,
          useTrash: false
        }
      );
    } catch(error: unknown) {
      if(!(error instanceof FileSystemError) || error.code !== 'FileNotFound') {
        throw error;
      }
    }
  }

  private async downloadArchive(downloadUri: string): Promise<Uri> {
    await mkdirAsync(this.getInstallationPath().fsPath, { recursive: true });
    return await new Promise<Uri>((resolve, reject) => {
      const archivePath = this.getZipPath();
      const archiveHandle = fs.createWriteStream(archivePath.fsPath);
      this.writeStatus(`downloading Dafny from ${downloadUri}`);
      const progressReporter = new ProgressReporter(this.statusOutput);
      archiveHandle
        .on('finish', () => resolve(archivePath))
        .on('error', error => reject(error));
      got.stream(downloadUri)
        .on('error', error => reject(error))
        .on('downloadProgress', progress => progressReporter.updateDownloadProgress(progress))
        .pipe(archiveHandle);
    });
  }

  private async extractArchive(archivePath: Uri): Promise<void> {
    const dirPath = this.getInstallationPath();
    this.writeStatus(`extracting Dafny to ${dirPath.fsPath}`);
    const progressReporter = new ProgressReporter(this.statusOutput);
    await extract(
      archivePath.fsPath,
      {
        dir: dirPath.fsPath,
        onEntry: (_, archive) => progressReporter.update(archive.entriesRead / archive.entryCount)
      }
    );
  }

  private getZipPath(): Uri {
    return Utils.joinPath(this.getInstallationPath(), ArchiveFileName);
  }

  private getInstallationPath(): Uri {
    return Utils.joinPath(
      this.context.extensionUri,
      ...LanguageServerConstants.GetResourceFolder(getConfiguredVersion())
    );
  }

  private getCustomInstallationPath(typeArch: string): Uri {
    return Utils.joinPath(
      this.getInstallationPath(), 'custom', typeArch
    );
  }

  private writeStatus(message: string): void {
    this.statusOutput.appendLine(message);
  }
}

class ProgressReporter {
  private lastTenth = -1;

  public constructor(private readonly statusOutput: OutputChannel) {}

  public updateDownloadProgress(progress: { percent: number, transferred: number }) {
    if(progress.transferred > 0) {
      // The transferred byte count has to be checked since got reports percent=1 at the beginning.
      this.update(progress.percent);
    }
  }

  public update(percent: number) {
    const tenth = Math.round(percent * 10);
    if(tenth > this.lastTenth) {
      this.statusOutput.append(`${tenth * 10}%`);
      if(tenth === 10) {
        this.statusOutput.appendLine('');
      } else {
        this.statusOutput.append('...');
      }
      this.lastTenth = tenth;
    }
  }
}
