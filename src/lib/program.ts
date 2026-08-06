import { type ReactNode, type FC } from "react";
import { Effect, Schema } from "effect";
import { Program } from ".";

type GenericModel = Schema.Struct<any>;
type GenericMessage = Schema.TaggedStruct<any, any>;

type Updaters<Model extends GenericModel, Message extends ReadonlyArray<GenericMessage>> =
  Message[number] extends Schema.TaggedStruct<infer Tag extends string, any>
    ? {
        [K in Tag]: (
          message: Extract<Message[number]["Type"], { _tag: K }>,
          model: Model["Type"],
        ) =>
          | Model["Type"]
          | [Model["Type"], Effect.Effect<Message[number]["Type"]>]
          | [Model["Type"], Effect.Effect<Message[number]["Type"]>[]];
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
  };
}

// export declare function init<
//   Model extends GenericModel,
//   Message extends ReadonlyArray<GenericMessage>,
//   Update extends Partial<Updaters<Model, Message>>,
// >(init: { update: Update }): (program: Program<Model, Message>) => FC<Schema.Schema.Type<Model>>;
