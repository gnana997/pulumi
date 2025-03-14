// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable */

import * as assert from "assert";
import {
    all,
    concat,
    deferredOutput,
    interpolate,
    isSecret,
    jsonParse,
    jsonStringify,
    Output,
    output,
    secret,
    unknown,
    unsecret,
} from "../output";
import { Resource } from "../resource";
import * as runtime from "../runtime";

interface Widget {
    type: string; // metric | text
    x?: number;
    y?: number;
    properties: Object;
}

// This ensures that the optionality of 'x' and 'y' are preserved when describing an Output<Widget>.
// Subtle changes in the definitions of Lifted<T> can make TS think these are required, which can
// break downstream consumers.
function mustCompile(): Output<Widget> {
    return output({
        type: "foo",
        properties: {
            whatever: 1,
        },
    });
}

// mockOutput returns a value that looks like an Output, but allows for greater control over its behavior. This can be
// used to simulate outputs from downlevel SDKs.
function mockOutput(isKnown: boolean | Promise<boolean>, value: any | Promise<any>): any {
    isKnown = isKnown instanceof Promise ? isKnown : Promise.resolve(isKnown);
    value = value instanceof Promise ? value : Promise.resolve(value);

    return {
        __pulumiOutput: true,
        isKnown: isKnown,
        isSecret: Promise.resolve(false),
        promise: () => value,
        resources: () => new Set<Resource>(),

        apply(callback: any): any {
            return mockOutput(
                isKnown,
                value.then(async (v: any) => {
                    if (!isKnown) {
                        return undefined;
                    }
                    return callback(v);
                }),
            );
        },
    };
}

describe("output", () => {
    describe("throws on circular structures", () => {
        const syncCases = [
            {
                name: "object in object",
                block: () => {
                    const a: any = {};
                    a.a = a;
                    output(a);
                },
            },
            {
                name: "array in array",
                block: () => {
                    const a: any[] = [];
                    a.push(a);
                    output(a);
                },
            },
            {
                name: "object in array in object",
                block: () => {
                    const a: any = { b: [] };
                    a.b.push(a);
                    output(a);
                },
            },
            {
                name: "array in object in array",
                block: () => {
                    const a: any[] = [];
                    a.push({ b: a });
                    output(a);
                },
            },
        ];
        for (const { name, block } of syncCases) {
            it(name, () => {
                assert.throws(block, /Cannot create an Output from a circular structure/);
            });
        }

        const asyncCases = [
            {
                name: "promise object in object",
                block: async () => {
                    const a: any = {};
                    a.a = Promise.resolve(a);
                    await output(a).promise();
                },
            },
            {
                name: "promise array in array",
                block: async () => {
                    const a: any[] = [];
                    a.push(Promise.resolve(a));
                    await output(a).promise();
                },
            },
            {
                name: "promise object in array in object",
                block: async () => {
                    const a: any = { b: [] };
                    a.b.push(Promise.resolve(a));
                    await output(a).promise();
                },
            },
            {
                name: "promise array in object in array",
                block: async () => {
                    const a: any[] = [];
                    a.push({ b: Promise.resolve(a) });
                    await output(a).promise();
                },
            },
        ];
        for (const { name, block } of asyncCases) {
            it(name, () => {
                assert.rejects(block, /Cannot create an Output from a circular structure/);
            });
        }
    });

    describe("doesn't throw for non-circular structures", () => {
        it("same object in array", async () => {
            const a = {};
            const b = [a, a];
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), [a, a]);
        });
        it("same array in object", async () => {
            const a: any[] = [];
            const b = { a: a, b: a };
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), { a: a, b: a });
        });
        it("same promise object in array", async () => {
            const a = Promise.resolve({});
            const b = [a, a];
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), [{}, {}]);
        });
        it("same object in promise in array", async () => {
            const a = {};
            const b = [Promise.resolve(a), Promise.resolve(a)];
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), [{}, {}]);
        });
        it("same promise array in object", async () => {
            const a = Promise.resolve([]);
            const b = { a: a, b: a };
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), { a: [], b: [] });
        });
        it("same array in promise in object", async () => {
            const a: any[] = [];
            const b = { a: Promise.resolve(a), b: Promise.resolve(a) };
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), { a: [], b: [] });
        });
        it("same output object in array", async () => {
            const a = output({});
            const b = [a, a];
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), [{}, {}]);
        });
        it("same output array in object", async () => {
            const a = output([]);
            const b = { a: a, b: a };
            const o = output(b);
            assert.deepStrictEqual(await o.promise(), { a: [], b: [] });
        });
    });

    it("propagates true isKnown bit from inner Output", async () => {
        runtime._setIsDryRun(true);

        const output1 = new Output(
            new Set(),
            Promise.resolve("outer"),
            Promise.resolve(true),
            Promise.resolve(false),
            Promise.resolve(new Set()),
        );
        const output2 = output1.apply(
            (v) =>
                new Output(
                    new Set(),
                    Promise.resolve("inner"),
                    Promise.resolve(true),
                    Promise.resolve(false),
                    Promise.resolve(new Set()),
                ),
        );

        const isKnown = await output2.isKnown;
        assert.strictEqual(isKnown, true);

        const value = await output2.promise();
        assert.strictEqual(value, "inner");
    });

    it("propagates false isKnown bit from inner Output", async () => {
        runtime._setIsDryRun(true);

        const output1 = new Output(
            new Set(),
            Promise.resolve("outer"),
            Promise.resolve(true),
            Promise.resolve(false),
            Promise.resolve(new Set()),
        );
        const output2 = output1.apply(
            (v) =>
                new Output(
                    new Set(),
                    Promise.resolve("inner"),
                    Promise.resolve(false),
                    Promise.resolve(false),
                    Promise.resolve(new Set()),
                ),
        );

        const isKnown = await output2.isKnown;
        assert.strictEqual(isKnown, false);

        const value = await output2.promise();
        assert.strictEqual(value, "inner");
    });

    it("can not await if isKnown is a rejected promise.", async () => {
        runtime._setIsDryRun(true);

        const output1 = new Output(
            new Set(),
            Promise.resolve("outer"),
            Promise.resolve(true),
            Promise.resolve(false),
            Promise.resolve(new Set()),
        );
        const output2 = output1.apply(
            (v) =>
                new Output(
                    new Set(),
                    Promise.resolve("inner"),
                    Promise.reject(new Error("foo")),
                    Promise.resolve(false),
                    Promise.resolve(new Set()),
                ),
        );

        try {
            const isKnown = await output2.isKnown;
            assert.fail("Should not reach here");
        } catch (err) {}

        try {
            const value = await output2.promise();
            assert.fail("Should not reach here");
        } catch (err) {}
    });

    it("propagates true isSecret bit from inner Output", async () => {
        runtime._setIsDryRun(true);

        const output1 = new Output(
            new Set(),
            Promise.resolve("outer"),
            Promise.resolve(true),
            Promise.resolve(false),
            Promise.resolve(new Set()),
        );
        const output2 = output1.apply(
            (v) =>
                new Output(
                    new Set(),
                    Promise.resolve("inner"),
                    Promise.resolve(true),
                    Promise.resolve(true),
                    Promise.resolve(new Set()),
                ),
        );

        const isSecret = await output2.isSecret;
        assert.strictEqual(isSecret, true);

        const value = await output2.promise();
        assert.strictEqual(value, "inner");
    });

    it("retains true isSecret bit from outer Output", async () => {
        runtime._setIsDryRun(true);

        const output1 = new Output(
            new Set(),
            Promise.resolve("outer"),
            Promise.resolve(true),
            Promise.resolve(true),
            Promise.resolve(new Set()),
        );
        const output2 = output1.apply(
            (v) =>
                new Output(
                    new Set(),
                    Promise.resolve("inner"),
                    Promise.resolve(true),
                    Promise.resolve(false),
                    Promise.resolve(new Set()),
                ),
        );

        const isSecret = await output2.isSecret;
        assert.strictEqual(isSecret, true);

        const value = await output2.promise();
        assert.strictEqual(value, "inner");
    });

    describe("apply", () => {
        function createOutput<T>(val: T, isKnown: boolean, isSecret: boolean = false): Output<T> {
            return new Output<T>(
                new Set(),
                Promise.resolve(val),
                Promise.resolve(isKnown),
                Promise.resolve(isSecret),
                Promise.resolve(new Set()),
            );
        }

        it("can run on known value during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), 1);
        });

        it("can run on known awaitable value during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("can run on known known output value during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("can run on known unknown output value during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("produces unknown default on unknown during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("produces unknown default on unknown awaitable during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("produces unknown default on unknown known output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("produces unknown default on unknown unknown output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("preserves secret on known during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), 1);
        });

        it("preserves secret on known awaitable during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on known known output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on known unknown output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on unknown during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("preserves secret on unknown awaitable during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("preserves secret on unknown known output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("preserves secret on unknown unknown output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("propagates secret on known known output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", true, true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("propagates secret on known unknown output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", false, true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("does not propagate secret on unknown known output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", true, true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("does not propagate secret on unknown unknown output during preview", async () => {
            runtime._setIsDryRun(true);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", false, true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, false);
            assert.strictEqual(await r.promise(), undefined);
        });

        it("can run on known value", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), 1);
        });

        it("can run on known awaitable value", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("can run on known known output value", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("can run on unknown known output value", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("produces unknown on unknown", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, false);
        });

        it("produces unknown on unknown awaitable", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, false);
        });

        it("produces unknown on unknown known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, false);
        });

        it("produces unknown on unknown unknown output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
        });

        it("preserves secret on known", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), 1);
        });

        it("preserves secret on known awaitable", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on known known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on known known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
            assert.strictEqual(await r.promise(), "inner");
        });

        it("preserves secret on unknown", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => v + 1);

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
        });

        it("preserves secret on unknown awaitable", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => Promise.resolve("inner"));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
        });

        it("preserves secret on unknown known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => createOutput("inner", true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
        });

        it("preserves secret on unknown known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, false, true);
            const r = out.apply((v) => createOutput("inner", false));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
        });

        it("propagates secret on known known output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", true, true));

            assert.strictEqual(await r.isKnown, true);
            assert.strictEqual(await r.isSecret, true);
        });

        it("propagates secret on known unknown output", async () => {
            runtime._setIsDryRun(false);

            const out = createOutput(0, true);
            const r = out.apply((v) => createOutput("inner", false, true));

            assert.strictEqual(await r.isKnown, false);
            assert.strictEqual(await r.isSecret, true);
        });
    });

    describe("isKnown", () => {
        function or<T>(output1: Output<T>, output2: Output<T>): Output<T> {
            const val1 = output1.promise();
            const val2 = output2.promise();
            return new Output<T>(
                new Set([...output1.resources(), ...output2.resources()]),
                Promise.all([val1, val2]).then(([val1, val2]) => val1 || val2),
                Promise.all([val1, output1.isKnown, output2.isKnown]).then(([val1, isKnown1, isKnown2]) =>
                    val1 ? isKnown1 : isKnown2,
                ),
                Promise.all([val1, output1.isSecret, output2.isSecret]).then(([val1, isSecret1, isSecret2]) =>
                    val1 ? isSecret1 : isSecret2,
                ),
                Promise.all([output1.allResources!(), output2.allResources!()]).then(
                    ([r1, r2]) => new Set([...r1, ...r2]),
                ),
            );
        }

        it("choose between known and known output, non-secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve("foo"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve("bar"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "foo");

            const secret = await result.isSecret;
            assert.strictEqual(secret, false);
        });

        it("choose between known and known output, secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve("foo"),
                Promise.resolve(true),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve("bar"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "foo");

            const secret = await result.isSecret;
            assert.strictEqual(secret, true);
        });

        it("choose between known and unknown output, non-secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve("foo"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "foo");

            const secret = await result.isSecret;
            assert.strictEqual(secret, false);
        });

        it("choose between known and unknown output, secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve("foo"),
                Promise.resolve(true),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "foo");

            const secret = await result.isSecret;
            assert.strictEqual(secret, true);
        });

        it("choose between unknown and known output, non-secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve("bar"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "bar");

            const secret = await result.isSecret;
            assert.strictEqual(secret, false);
        });

        it("choose between unknown and known output, secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve("bar"),
                Promise.resolve(true),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, true);

            const value = await result.promise();
            assert.strictEqual(value, "bar");

            const secret = await result.isSecret;
            assert.strictEqual(secret, true);
        });

        it("choose between unknown and unknown output, non-secret", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, false);

            const value = await result.promise();
            assert.strictEqual(value, undefined);

            const secret = await result.isSecret;
            assert.strictEqual(secret, false);
        });

        it("choose between unknown and unknown output, secret1", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, false);

            const value = await result.promise();
            assert.strictEqual(value, undefined);

            const secret = await result.isSecret;
            assert.strictEqual(secret, false);
        });

        it("choose between unknown and unknown output, secret2", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, false);

            const value = await result.promise();
            assert.strictEqual(value, undefined);

            const secret = await result.isSecret;
            assert.strictEqual(secret, true);
        });

        it("choose between unknown and unknown output, secret3", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(undefined),
                Promise.resolve(false),
                Promise.resolve(true),
                Promise.resolve(new Set()),
            );

            const result = or(o1, o2);

            const isKnown = await result.isKnown;
            assert.strictEqual(isKnown, false);

            const value = await result.promise();
            assert.strictEqual(value, undefined);

            const secret = await result.isSecret;
            assert.strictEqual(secret, true);
        });

        it("is unknown if the value is or contains unknowns", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve(unknown),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o2 = new Output(
                new Set(),
                Promise.resolve(["foo", unknown]),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const o3 = new Output(
                new Set(),
                Promise.resolve({ foo: "foo", unknown }),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            assert.strictEqual(await o1.isKnown, false);
            assert.strictEqual(await o2.isKnown, false);
            assert.strictEqual(await o3.isKnown, false);
        });

        it("is unknown if the result after apply is unknown or contains unknowns", async () => {
            runtime._setIsDryRun(true);

            const o1 = new Output(
                new Set(),
                Promise.resolve("foo"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );
            const r1 = o1.apply((v) => unknown);
            const r2 = o1.apply((v) => [v, unknown]);
            const r3 = o1.apply((v) => <any>{ v, unknown });
            const r4 = (<any>o1.apply((v) => unknown)).apply((v: any) => v, true);
            const r5 = (<any>o1.apply((v) => [v, unknown])).apply((v: any) => v, true);
            const r6 = (<any>o1.apply((v) => <any>{ v, unknown })).apply((v: any) => v, true);

            assert.strictEqual(await r1.isKnown, false);
            assert.strictEqual(await r2.isKnown, false);
            assert.strictEqual(await r3.isKnown, false);
            assert.strictEqual(await r4.isKnown, false);
            assert.strictEqual(await r5.isKnown, false);
            assert.strictEqual(await r6.isKnown, false);
        });
    });

    describe("concat", () => {
        it("handles no args", async () => {
            const result = concat();
            assert.strictEqual(await result.promise(), "");
        });

        it("handles empty string arg", async () => {
            const result = concat("");
            assert.strictEqual(await result.promise(), "");
        });

        it("handles non-empty string arg", async () => {
            const result = concat("a");
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles promise string arg", async () => {
            const result = concat(Promise.resolve("a"));
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles output string arg", async () => {
            const result = concat(output("a"));
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles multiple args", async () => {
            const result = concat("http://", output("a"), ":", 80);
            assert.strictEqual(await result.promise(), "http://a:80");
        });
    });

    describe("interpolate", () => {
        it("handles empty interpolation", async () => {
            const result = interpolate``;
            assert.strictEqual(await result.promise(), "");
        });

        it("handles no placeholders arg", async () => {
            const result = interpolate`a`;
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles string placeholders arg", async () => {
            const result = interpolate`${"a"}`;
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles promise placeholders arg", async () => {
            const result = interpolate`${Promise.resolve("a")}`;
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles output placeholders arg", async () => {
            const result = interpolate`${output("a")}`;
            assert.strictEqual(await result.promise(), "a");
        });

        it("handles multiple args", async () => {
            const result = interpolate`http://${output("a")}:${80}/`;
            assert.strictEqual(await result.promise(), "http://a:80/");
        });
    });

    describe("jsonStringify", () => {
        it("basic", async () => {
            const x = output([0, 1]);
            const result = jsonStringify(x);
            assert.strictEqual(await result.promise(), "[0,1]");
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, false);
        });

        it("nested", async () => {
            const x = output([output(0), output(1)]);
            const result = jsonStringify(x);
            assert.strictEqual(await result.promise(), "[0,1]");
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, false);
        });

        it("nested unknowns", async () => {
            const x = output([
                new Output(
                    new Set(),
                    Promise.resolve(undefined),
                    Promise.resolve(false),
                    Promise.resolve(false),
                    Promise.resolve(new Set()),
                ),
                output(1),
            ]);
            const result = jsonStringify(x);
            assert.strictEqual(await result.isKnown, false);
            assert.strictEqual(await result.isSecret, false);
        });

        it("nested secret", async () => {
            const x = output([
                new Output(
                    new Set(),
                    Promise.resolve(0),
                    Promise.resolve(true),
                    Promise.resolve(true),
                    Promise.resolve(new Set()),
                ),
                output(1),
            ]);
            const result = jsonStringify(x);
            assert.strictEqual(await result.promise(), "[0,1]");
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, true);
        });

        it("with options", async () => {
            const x = output([0, 1]);
            const result = jsonStringify(x, undefined, " ");
            assert.strictEqual(await result.promise(), "[\n 0,\n 1\n]");
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, false);
        });

        it("nested dependencies", async () => {
            // Output's don't actually _look_ at the resources, they just need to keep a collection of them
            const mockResource: Resource = {} as any;
            const mockResources: Resource[] = [mockResource];

            const x = output([
                new Output(
                    new Set(mockResources),
                    Promise.resolve(0),
                    Promise.resolve(true),
                    Promise.resolve(true),
                    Promise.resolve(new Set()),
                ),
                output(1),
            ]);
            const result = jsonStringify(x);
            assert.strictEqual(await result.promise(), "[0,1]");
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, true);
            if (result.allResources === undefined) {
                assert.fail("Output.allResources was undefined");
            }
            const allResources = await result.allResources();
            // We should have just the one mockResource in this set
            assert.strictEqual(allResources.size, 1);
            assert.ok(allResources.has(mockResource));
        });
    });

    describe("jsonParse", () => {
        it("basic", async () => {
            const x = output("[0, 1]");
            const result = jsonParse(x);
            assert.deepStrictEqual(await result.promise(), [0, 1]);
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, false);
        });

        it("with reviver", async () => {
            const reviver = (key: string, value: any): any => {
                if (key === "bob") {
                    return "goodbye";
                }
                return value;
            };
            const x = output('{"bob": "hello"}');
            const result = jsonParse(x, reviver);
            assert.deepStrictEqual(await result.promise(), { bob: "goodbye" });
            assert.strictEqual(await result.isKnown, true);
            assert.strictEqual(await result.isSecret, false);
        });
    });

    describe("output types", () => {
        it("creates the right type for arrays", async () => {
            const input: Array<Output<string>> = [output("hello"), output("world")];
            const result: Array<string> = await all(input).promise();
            assert.deepStrictEqual(result, ["hello", "world"]);
        });

        it("creates the right type for tuples", async () => {
            const input: [Output<string>, Output<number>] = [output("hello"), output(123)];
            const result: [string, number] = await all(input).promise();
            assert.deepStrictEqual(result, ["hello", 123]);
        });

        it("creates the right type for many tuples", async () => {
            // https://github.com/pulumi/pulumi/issues/17704#issuecomment-2460209864
            const input: Output<[string, number]>[] = [output(["hello", 123]), output(["world", 456])];
            const result: Array<[string, number]> = await all(input).promise();
            assert.deepStrictEqual(result, [
                ["hello", 123],
                ["world", 456],
            ]);
        });

        it("creates the right type for objects", async () => {
            const input = {
                name: output("Tom"),
                likes_dogs: output(true),
            };

            const result: { name: string; likes_dogs: boolean } = await output(input).promise();
            assert.deepStrictEqual(result, { name: "Tom", likes_dogs: true });
        });
    });

    describe("secret operations", () => {
        it("ensure secret", async () => {
            const sec = secret("foo");
            assert.strictEqual(await sec.isSecret, true);
        });
        it("ensure that a secret can be unwrapped", async () => {
            const sec = secret("foo");
            assert.strictEqual(await isSecret(sec), true);

            const unsec = unsecret(sec);
            assert.strictEqual(await isSecret(unsec), false);
            assert.strictEqual(await unsec.promise(), "foo");
        });
    });

    describe("lifted operations", () => {
        it("lifts properties from inner object", async () => {
            const output1 = output({ a: 1, b: true, c: "str", d: [2], e: { f: 3 }, g: undefined, h: null });

            assert.strictEqual(await output1.a.promise(), 1);
            assert.strictEqual(await output1.b.promise(), true);
            assert.strictEqual(await output1.c.promise(), "str");

            // Can lift both outer arrays as well as array accesses
            assert.deepStrictEqual(await output1.d.promise(), [2]);
            assert.strictEqual(await output1.d[0].promise(), 2);

            // Can lift nested objects as well as their properties.
            assert.deepStrictEqual(await output1.e.promise(), { f: 3 });
            assert.strictEqual(await output1.e.f.promise(), 3);

            assert.strictEqual(await output1.g.promise(), undefined);
            assert.strictEqual(await output1.h.promise(), null);

            // Unspecified things can be lifted, but produce 'undefined'.
            assert.notEqual((<any>output1).z, undefined);
            assert.strictEqual(await (<any>output1).z.promise(), undefined);
        });

        it("prefers Output members over lifted members", async () => {
            const output1 = output({ apply: 1, promise: 2 });
            assert.ok(output1.apply instanceof Function);
            assert.ok(output1.isKnown instanceof Promise);
        });

        it("does not lift symbols", async () => {
            const output1 = output({ apply: 1, promise: 2 });
            assert.strictEqual((<any>output1)[Symbol.toPrimitive], undefined);
        });

        it("does not lift __ properties", async () => {
            const output1 = output({ a: 1, b: 2 });
            assert.strictEqual((<any>output1).__pulumiResource, undefined);
        });

        it("lifts properties from values with nested unknowns", async () => {
            runtime._setIsDryRun(true);

            const output1 = output({
                foo: "foo",
                bar: unknown,
                baz: Promise.resolve(unknown),
                qux: mockOutput(false, undefined),
            });
            assert.strictEqual(await output1.isKnown, false);

            const result1 = output1.foo;
            assert.strictEqual(await result1.isKnown, true);
            assert.strictEqual(await (<any>result1).promise(/*withUnknowns*/ true), "foo");

            const result2 = output1.bar;
            assert.strictEqual(await result2.isKnown, false);
            assert.strictEqual(await (<any>result2).promise(/*withUnknowns*/ true), unknown);

            const result3 = output1.baz;
            assert.strictEqual(await result3.isKnown, false);
            assert.strictEqual(await (<any>result3).promise(/*withUnknowns*/ true), unknown);

            const result4 = output1.qux;
            assert.strictEqual(await result4.isKnown, false);
            assert.strictEqual(await (<any>result4).promise(/*withUnknowns*/ true), unknown);

            const result5 = (<any>output1.baz).qux;
            assert.strictEqual(await result5.isKnown, false);
            assert.strictEqual(await (<any>result5).promise(/*withUnknowns*/ true), unknown);

            const output2 = output(["foo", unknown, mockOutput(false, undefined)]);
            assert.strictEqual(await output2.isKnown, false);

            const result6 = output2[0];
            assert.strictEqual(await result6.isKnown, true);
            assert.strictEqual(await (<any>result6).promise(/*withUnknowns*/ true), "foo");

            const result7 = output2[1];
            assert.strictEqual(await result7.isKnown, false);
            assert.strictEqual(await (<any>result7).promise(/*withUnknowns*/ true), unknown);

            const result8 = output2[2];
            assert.strictEqual(await result8.isKnown, false);
            assert.strictEqual(await (<any>result8).promise(/*withUnknowns*/ true), unknown);

            const output3 = all([unknown, mockOutput(false, undefined), output(["foo", unknown])]);
            assert.strictEqual(await output3.isKnown, false);

            const result9 = output3[0];
            assert.strictEqual(await result9.isKnown, false);
            assert.strictEqual(await (<any>result9).promise(/*withUnknowns*/ true), unknown);

            const result10 = output3[1];
            assert.strictEqual(await result10.isKnown, false);
            assert.strictEqual(await (<any>result10).promise(/*withUnknowns*/ true), unknown);

            const result11 = output3[2];
            assert.strictEqual(await result11.isKnown, false);

            const result12 = (<any>result11)[0];
            assert.strictEqual(await result12.isKnown, true);
            assert.strictEqual(await (<any>result12).promise(/*withUnknowns*/ true), "foo");

            const result13 = (<any>result11)[1];
            assert.strictEqual(await result13.isKnown, false);
            assert.strictEqual(await (<any>result13).promise(/*withUnknowns*/ true), unknown);

            const output4 = all({
                foo: unknown,
                bar: mockOutput(false, undefined),
                baz: output({ foo: "foo", qux: unknown }),
            });
            assert.strictEqual(await output4.isKnown, false);

            const result14 = output4.foo;
            assert.strictEqual(await result14.isKnown, false);
            assert.strictEqual(await (<any>result14).promise(/*withUnknowns*/ true), unknown);

            const result15 = output4.bar;
            assert.strictEqual(await result15.isKnown, false);
            assert.strictEqual(await (<any>result15).promise(/*withUnknowns*/ true), unknown);

            const result16 = output4.baz;
            assert.strictEqual(await result16.isKnown, false);

            const result17 = (<any>result16).foo;
            assert.strictEqual(await result17.isKnown, true);
            assert.strictEqual(await (<any>result17).promise(/*withUnknowns*/ true), "foo");

            const result18 = (<any>result16).qux;
            assert.strictEqual(await result18.isKnown, false);
            assert.strictEqual(await (<any>result18).promise(/*withUnknowns*/ true), unknown);
        });
    });

    describe("deferred", () => {
        it("can be created", async () => {
            const [output, resolveFrom] = deferredOutput<string>();

            const source = new Output(
                new Set(),
                Promise.resolve("Hello"),
                Promise.resolve(true),
                Promise.resolve(false),
                Promise.resolve(new Set()),
            );

            resolveFrom(source);

            assert.strictEqual(await output.promise(), "Hello");
            assert.strictEqual(await output.isKnown, true);
            assert.strictEqual(await output.isSecret, false);
            const resources = await output.allResources!();
            assert.strictEqual(resources.size, 0);
        });

        it("can be created from secret output", async () => {
            const [output, resolveFrom] = deferredOutput<string>();

            const source = new Output(
                new Set(),
                Promise.resolve("Hello"),
                Promise.resolve(true),
                Promise.resolve(true), // secret
                Promise.resolve(new Set()),
            );

            resolveFrom(source);

            assert.strictEqual(await output.promise(), "Hello");
            assert.strictEqual(await output.isKnown, true);
            assert.strictEqual(await output.isSecret, true);
            const resources = await output.allResources!();
            assert.strictEqual(resources.size, 0);
        });
    });

    describe("toString", () => {
        it("toString message", async () => {
            const x = output([0, 1]);
            const result = x.toString();
            assert.match(result, /Calling \[toString\] on an \[Output<T>\] is not supported\./);
        });
    });
});
