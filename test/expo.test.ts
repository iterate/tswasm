import fs from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import { expect, test as baseTest } from "vitest";

import { packageRoot } from "./fixtures/ensure-built.js";
import {
  captureOutput,
  createBrowserRpcFixture,
  type BrowserRpcFixture,
  type RenderedHost,
  runCommand,
  stopProcess,
} from "./fixtures/browser-rpc-fixture.js";

const test = baseTest.skipIf(!process.env.TSWASM_EXPO_TEST);

declare const createCompiler: typeof import("../dist/index.js").createCompiler;

test("createCompiler works in a real Expo web app", { timeout: 180_000 }, async () => {
  await using fixture = await createExpoWebFixture(
    class ExpoCompileTest {
      tsPromise: ReturnType<typeof createCompiler>;

      constructor(wasm: WebAssembly.Module) {
        this.tsPromise = createCompiler({ wasm });
      }

      async compileValue() {
        return (await this.tsPromise).compile("const x: number = 123");
      }

      async compileError() {
        return (await this.tsPromise).compile("const value: number = \"nope\";");
      }
    },
  );

  expect(await fixture.stub.compileValue()).toMatchObject({
    success: true,
    diagnostics: [],
    js: expect.stringContaining("const x = 123;"),
  });

  expect(await fixture.stub.compileError()).toMatchObject({
    success: false,
    js: expect.stringContaining('const value = "nope";'),
    diagnostics: [
      {
        code: 2322,
        category: "error",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
});

function createExpoWebFixture<TInstance extends object>(
  classDef: new (...args: any[]) => TInstance,
): Promise<BrowserRpcFixture<TInstance>> {
  return createBrowserRpcFixture({
    classDef,
    async renderHost({ root, port, classDefString, className, methodNames }): Promise<RenderedHost> {
      await Promise.all([
        fs.mkdir(path.join(root, "public"), { recursive: true }),
        fs.writeFile(
          path.join(root, "package.json"),
          `
            {
              "name": "tswasm-expo-web-fixture",
              "private": true,
              "dependencies": {
                "expo": "55.0.13",
                "react": "19.2.0",
                "react-dom": "19.2.0",
                "react-native": "0.83.4",
                "react-native-web": "0.21.2"
              }
            }
          `,
        ),
        fs.writeFile(
          path.join(root, "app.json"),
          `
            {
              "expo": {
                "name": "tswasm expo web fixture",
                "slug": "tswasm-expo-web-fixture"
              }
            }
          `,
        ),
        fs.writeFile(
          path.join(root, "metro.config.js"),
          `
            const { getDefaultConfig } = require("expo/metro-config");
            const config = getDefaultConfig(__dirname);
            config.resolver.assetExts.push("wasm");
            module.exports = config;
          `,
        ),
        fs.cp(path.join(packageRoot, "dist"), path.join(root, "runtime"), { recursive: true }),
        fs.copyFile(path.join(packageRoot, "dist", "tswasm.wasm"), path.join(root, "public", "tswasm.wasm")),
      ]);

      await fs.writeFile(
        path.join(root, "App.js"),
        `
          import React from "react";
          import { Button, Text, TextInput, View } from "react-native";
          import { createCompiler } from "./runtime/index.js";

          ${classDefString}

          const methodNames = ${JSON.stringify(methodNames)};
          let fixturePromise;

          function bootFixture() {
            if (!fixturePromise) {
              fixturePromise = fetch("/tswasm.wasm")
                .then((response) => {
                  if (!response.ok) {
                    throw new Error("failed to load tswasm.wasm: " + response.status);
                  }
                  return response.arrayBuffer();
                })
                .then((bytes) => WebAssembly.compile(bytes))
                .then((wasm) => new ${className}(wasm));
            }
            return fixturePromise;
          }

          export default class App extends React.Component {
            state = {
              bootStatus: "booting",
              bootError: "",
              argTexts: Object.fromEntries(methodNames.map((method) => [method, "[]"])),
              requestId: 0,
              callStatus: "idle",
              callResult: "",
              callError: "",
            };

            componentDidMount() {
              bootFixture().then(
                () => this.setState({ bootStatus: "ready" }),
                (error) => this.setState({ bootStatus: "error", bootError: String(error) }),
              );
            }

            async invoke(method) {
              const nextRequestId = this.state.requestId + 1;
              this.setState({
                requestId: nextRequestId,
                callStatus: "running",
                callResult: "",
                callError: "",
              });

              try {
                const parsed = JSON.parse(this.state.argTexts[method]);
                if (!Array.isArray(parsed)) {
                  throw new Error("Method args must be a JSON array");
                }
                const fixture = await bootFixture();
                const value = await fixture[method](...parsed);
                this.setState({
                  callResult: JSON.stringify({ requestId: nextRequestId, value }),
                  callStatus: "success",
                });
              } catch (error) {
                this.setState({
                  callError: JSON.stringify({ requestId: nextRequestId, message: String(error) }),
                  callStatus: "error",
                });
              }
            }

            render() {
              return (
                <View>
                  <Text testID="boot-status">{this.state.bootStatus}</Text>
                  <Text testID="boot-error">{this.state.bootError}</Text>
                  <Text testID="rpc-request-id">{String(this.state.requestId)}</Text>
                  <Text testID="rpc-status">{this.state.callStatus}</Text>
                  <Text testID="rpc-result">{this.state.callResult}</Text>
                  <Text testID="rpc-error">{this.state.callError}</Text>
                  {methodNames.map((method) => (
                    <View key={method}>
                      <TextInput
                        testID={\`rpc-input-\${method}\`}
                        value={this.state.argTexts[method]}
                        onChangeText={(text) => {
                          this.setState((current) => ({
                            argTexts: { ...current.argTexts, [method]: text },
                          }));
                        }}
                      />
                      <Button
                        testID={\`rpc-\${method}\`}
                        title={method}
                        onPress={() => {
                          void this.invoke(method);
                        }}
                      />
                    </View>
                  ))}
                </View>
              );
            }
          }
        `,
      );

      const env = { CI: "1", EXPO_NO_TELEMETRY: "1" };

      await runCommand("pnpm", ["install"], root, env);

      const server = execa("pnpm", ["exec", "expo", "start", "--port", String(port)], {
        cwd: root,
        env,
        all: true,
        reject: false,
      });
      const serverLogs = captureOutput(server);

      return {
        serverLogs,
        async [Symbol.asyncDispose]() {
          await stopProcess(server);
        },
      };
    },
    bootTimeoutMs: 60_000,
    rpcTimeoutMs: 60_000,
  });
}
