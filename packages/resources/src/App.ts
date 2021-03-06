import chalk from "chalk";
import * as path from "path";
import * as fs from "fs-extra";
import * as spawn from "cross-spawn";
import * as cdk from "@aws-cdk/core";
import * as cxapi from "@aws-cdk/cx-api";
import { execSync } from "child_process";
import { HandlerProps } from "./Function";
import { getEsbuildMetafileName } from "./util/builder";

const appPath = process.cwd();
const appNodeModules = path.join(appPath, "node_modules");

/**
 * Finds the path to a package executable by converting the file path of:
 * /Users/spongebob/serverless-stack-toolkit/node_modules/typescript/dist/index.js
 * to:
 * /Users/spongebob/serverless-stack-toolkit/node_modules/.bin/typescript
 * or if the executable name (exeName) is different
 * /Users/spongebob/serverless-stack-toolkit/node_modules/.bin/tsc
 */
function getBinPath(pkg: string, exeName?: string): string {
  const filePath = require.resolve(pkg);
  const matches = filePath.match(/(^.*\/node_modules)\/.*$/);

  if (matches === null || !matches[1]) {
    throw new Error(`There was a problem finding ${pkg}`);
  }

  return path.join(matches[1], ".bin", exeName || pkg);
}

function exitWithMessage(message: string) {
  console.error(message);
  process.exit(1);
}

/**
 * Deploy props for apps.
 */
export interface DeployProps {
  /**
   * The app name, used to prefix stacks.
   *
   * @default - Defaults to empty string
   */
  readonly name?: string;

  /**
   * The stage to deploy this app to.
   *
   * @default - Defaults to dev
   */
  readonly stage?: string;

  /**
   * The region to deploy this app to.
   *
   * @default - Defaults to us-east-1
   */
  readonly region?: string;

  /**
   * The local WebSockets debug enpoint used by `sst start`.
   *
   * @default - Defaults to undefined
   */
  readonly debugEndpoint?: string;

  /**
   * The callback after synth completes, used by `sst start`.
   *
   * @default - Defaults to undefined
   */
  readonly synthCallback?: (lambdaHandlers: Array<HandlerProps>) => void;
}

export type AppProps = cdk.AppProps;

export class App extends cdk.App {
  /**
   * Is the app being deployed locally
   */
  public readonly local: boolean = false;

  /**
   * The app name
   */
  public readonly name: string;

  /**
   * The stage to deploy to
   */
  public readonly stage: string;

  /**
   * The region to deploy to
   */
  public readonly region: string;

  /**
   * The local WebSockets debug endpoint
   */
  public readonly debugEndpoint?: string;

  /**
   * The build dir for the SST app
   */
  public readonly buildDir: string = ".build";

  /**
   * The callback after synth completes.
   */
  private readonly synthCallback?: (
    lambdaHandlers: Array<HandlerProps>
  ) => void;

  /**
   * A list of Lambda functions in the app
   */
  private readonly lambdaHandlers: Array<HandlerProps> = [];

  constructor(deployProps: DeployProps = {}, props: AppProps = {}) {
    super(props);

    this.stage = deployProps.stage || "dev";
    this.name = deployProps.name || "my-app";
    this.region = deployProps.region || "us-east-1";

    if (deployProps.debugEndpoint) {
      this.local = true;
      this.debugEndpoint = deployProps.debugEndpoint;
      this.synthCallback = deployProps.synthCallback;
    }
  }

  logicalPrefixedName(logicalName: string): string {
    const namePrefix = this.name === "" ? "" : `${this.name}-`;
    return `${this.stage}-${namePrefix}${logicalName}`;
  }

  synth(options: cdk.StageSynthesisOptions = {}): cxapi.CloudAssembly {
    for (const child of this.node.children) {
      if (
        child instanceof cdk.Stack &&
        child.stackName.indexOf(`${this.stage}-`) !== 0
      ) {
        throw new Error(
          `Stack (${child.stackName}) is not prefixed with the stage. Use sst.Stack or the format {stageName}-${child.stackName}.`
        );
      }
    }
    const cloudAssembly = super.synth(options);

    // Run lint and type check on handler input files
    // Note: do not need to run while debugging because the Lambda functions are replaced by
    //       stubs and have not been transpiled.
    if (!this.local) {
      this.processInputFiles();
    }

    // Run callback after synth has finished
    if (this.synthCallback) {
      this.synthCallback(this.lambdaHandlers);
    }

    return cloudAssembly;
  }

  registerLambdaHandler(handler: HandlerProps): void {
    this.lambdaHandlers.push(handler);
  }

  processInputFiles(): void {
    // Get input files
    const inputFilesBySrcPath: {
      [key: string]: { [key: string]: boolean };
    } = {};
    this.lambdaHandlers.forEach(({ srcPath, handler }) => {
      const buildPath = path.join(srcPath, this.buildDir);
      const metafile = path.join(buildPath, getEsbuildMetafileName(handler));
      const files = this.getInputFilesFromEsbuildMetafile(metafile);
      files.forEach((file) => {
        inputFilesBySrcPath[srcPath] = inputFilesBySrcPath[srcPath] || {};
        inputFilesBySrcPath[srcPath][file] = true;
      });
    });

    // Process each srcPath
    Object.keys(inputFilesBySrcPath).forEach((srcPath) => {
      const inputFiles = Object.keys(inputFilesBySrcPath[srcPath]);
      this.lint(srcPath, inputFiles);
      this.typeCheck(srcPath, inputFiles);
    });
  }

  getInputFilesFromEsbuildMetafile(file: string): Array<string> {
    let metaJson;

    try {
      metaJson = fs.readJsonSync(file);
    } catch (e) {
      exitWithMessage("There was a problem reading the esbuild metafile.");
    }

    return Object.keys(metaJson.inputs).map((input) => path.resolve(input));
  }

  lint(srcPath: string, inputFiles: Array<string>): void {
    inputFiles = inputFiles.filter(
      (file: string) =>
        file.indexOf("node_modules") === -1 &&
        (file.endsWith(".ts") || file.endsWith(".js"))
    );

    console.log(chalk.grey("Linting Lambda function source"));

    const response = spawn.sync(
      "node",
      [
        path.join(appPath, this.buildDir, "eslint.js"),
        process.env.NO_COLOR === "true" ? "--no-color" : "--color",
        ...inputFiles,
      ],
      { stdio: "inherit", cwd: srcPath }
    );

    if (response.error) {
      console.log(response.error);
      exitWithMessage("There was a problem linting the source.");
    } else if (response.stderr) {
      console.log(response.stderr);
      exitWithMessage("There was a problem linting the source.");
    } else if (response.status === 1) {
      exitWithMessage("There was a problem linting the source.");
    }
  }

  typeCheck(srcPath: string, inputFiles: Array<string>): void {
    inputFiles = inputFiles.filter((file: string) => file.endsWith(".ts"));

    if (inputFiles.length === 0) {
      return;
    }

    console.log(chalk.grey("Type checking Lambda function source"));

    try {
      const stdout = execSync(
        [
          getBinPath("typescript", "tsc"),
          "--pretty",
          process.env.NO_COLOR === "true" ? "false" : "true",
          "--noEmit",
        ].join(" "),
        { cwd: srcPath }
      );
      const output = stdout.toString();
      if (output.trim() !== "") {
        console.log(output);
      }
    } catch (e) {
      console.log(e.stdout.toString());
      exitWithMessage("There was a problem type checking the source.");
    }
  }
}
