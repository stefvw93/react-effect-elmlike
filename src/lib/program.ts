import { type ReactNode, type FC, useMemo, useRef, useState } from "react";
import { Effect, Result, Schema } from "effect";
import { Program } from ".";

type GenericModel = Schema.Struct<any>;
type GenericMessage = Schema.TaggedStruct<any, any>;

type Updaters<Model extends GenericModel, Message extends ReadonlyArray<GenericMessage>> =
  Message[number] extends Schema.TaggedStruct<infer Tag extends string, any>
    ? {
        [K in Tag]: (
          message: Extract<Message[number]["Type"], { _tag: K }>,
          model: Model["Type"],
        ) => Effect.Effect<Model["Type"]>;
      }
    : never;

type View<Model extends GenericModel, Message extends ReadonlyArray<GenericMessage>> = (
  model: Schema.Schema.Type<Model>,
  dispatch: (message: Schema.Schema.Type<Message[number]>) => void,
) => ReactNode;

export interface Program<
  Model extends GenericModel,
  Message extends ReadonlyArray<GenericMessage>,
> extends Effect.Effect<
  { model: Model; message: Message; view: View<Model, Message> },
  never,
  never
> {}

export function make<
  Model extends GenericModel,
  Message extends ReadonlyArray<GenericMessage>,
>(config: { model: Model; message: Message; view: View<Model, Message> }): Program<Model, Message> {
  return Effect.succeed(config);
}

export function init<
  Model extends GenericModel,
  Message extends ReadonlyArray<GenericMessage>,
  Update extends Partial<Updaters<Model, Message>>,
>(program: Program<Model, Message>, init: { update: Update }): FC<Schema.Schema.Type<Model>> {
  return (props: Schema.Schema.Type<Model>) => {
    // uses default effect runtime,
    // but would be better to have dedicated runtime injected via react context:
    // const runtime = useEffectRuntime();
    const {
      model: modelSchema,
      message: messageList,
      view,
    } = useMemo(() => Effect.runSync(program), []);

    const decodePropsSync = useMemo(
      () =>
        Schema.decodeUnknownResult(
          modelSchema as unknown as Schema.ConstraintDecoder<Model["Type"]>,
        ),
      [modelSchema],
    );

    // oxlint-disable-next-line react-hooks/exhaustive-deps
    const safeProps = useMemo(() => decodePropsSync(props), [decodePropsSync]);
    const messageUnion = useMemo(() => Schema.Union(messageList), [messageList]);

    if (Result.isFailure(safeProps)) {
      throw new Error("not sure what to do now? crash react? render nothing?");
    }

    const [model, updateModel] = useState(() => safeProps.success);
    const dispatchController = useRef<AbortController>(undefined);

    const dispatch = useMemo(() => {
      return (unsafeMessage: Record<string, unknown>) => {
        dispatchController.current?.abort();
        dispatchController.current = new AbortController();

        void Effect.runPromiseExit(
          Effect.gen(function* () {
            const result = Schema.decodeUnknownResult(
              messageUnion as unknown as Schema.TaggedStruct<string, {}>,
            )(unsafeMessage);

            if (Result.isFailure(result)) {
              return yield* Effect.fail("is not good");
            }

            const match = init.update[result.success._tag]?.(result.success as any, model);
            if (match) {
              const nextState = yield* match;
              updateModel(nextState);
              return nextState;
            }
          }),
          {
            signal: dispatchController.current.signal,
          },
        ).then(console.log);
      };
    }, [model, messageUnion]);

    return useMemo(
      () => view(model as Schema.Schema.Type<Model>, dispatch),
      [model, view, dispatch],
    );
  };
}

// export declare function init<
//   Model extends GenericModel,
//   Message extends ReadonlyArray<GenericMessage>,
//   Update extends Partial<Updaters<Model, Message>>,
// >(init: { update: Update }): (program: Program<Model, Message>) => FC<Schema.Schema.Type<Model>>;
