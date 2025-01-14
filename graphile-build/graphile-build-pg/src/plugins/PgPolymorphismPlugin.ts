import "graphile-config";
import "./PgCodecsPlugin.js";
import "./PgProceduresPlugin.js";
import "./PgRelationsPlugin.js";
import "./PgTablesPlugin.js";

import type {
  PgCodec,
  PgCodecExtensions,
  PgCodecPolymorphism,
  PgCodecPolymorphismRelational,
  PgCodecPolymorphismRelationalTypeSpec,
  PgCodecPolymorphismSingle,
  PgCodecPolymorphismSingleTypeAttributeSpec,
  PgCodecPolymorphismSingleTypeSpec,
  PgCodecRef,
  PgCodecRelation,
  PgCodecWithAttributes,
  PgRefDefinition,
  PgRegistry,
  PgResource,
  PgResourceOptions,
} from "@dataplan/pg";
import { assertPgClassSingleStep } from "@dataplan/pg";
import { arraysMatch } from "grafast";
import type {
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
} from "grafast/graphql";
import { gatherConfig } from "graphile-build";

import { getBehavior } from "../behavior.js";
import { parseDatabaseIdentifier, parseSmartTagsOptsString } from "../utils.js";
import { version } from "../version.js";

function isNotNullish<T>(v: T | null | undefined): v is T {
  return v != null;
}

declare global {
  namespace GraphileConfig {
    interface GatherHelpers {
      pgPolymorphism: Record<string, never>;
    }
  }
  namespace GraphileBuild {
    interface ScopeInterface {
      pgCodec?: PgCodec<any, any, any, any, any, any, any>;
      isPgPolymorphicTableType?: boolean;
      pgPolymorphism?: PgCodecPolymorphism<string>;
    }
    interface ScopeObject {
      pgPolymorphism?: PgCodecPolymorphism<string>;
      pgPolymorphicSingleTableType?: {
        typeIdentifier: string;
        name: string;
        attributes: ReadonlyArray<PgCodecPolymorphismSingleTypeAttributeSpec>;
      };
      pgPolymorphicRelationalType?: {
        typeIdentifier: string;
        name: string;
      };
    }
    interface ScopeEnum {
      pgPolymorphicSingleTableType?: {
        typeIdentifier: string;
        name: string;
        attributes: ReadonlyArray<PgCodecPolymorphismSingleTypeAttributeSpec>;
      };
    }
  }
}

function parseAttribute(
  colSpec: string,
): PgCodecPolymorphismSingleTypeAttributeSpec {
  let spec = colSpec;
  let isNotNull = false;
  if (spec.endsWith("!")) {
    spec = spec.substring(0, spec.length - 1);
    isNotNull = true;
  }
  const [a, b] = spec.split(">");
  return {
    attribute: a,
    isNotNull,
    rename: b,
  };
}

const EMPTY_OBJECT = Object.freeze({});

export const PgPolymorphismPlugin: GraphileConfig.Plugin = {
  name: "PgPolymorphismPlugin",
  description: "Adds polymorphism",
  version,
  after: ["smart-tags", "PgTablesPlugin", "PgCodecsPlugin"],
  gather: gatherConfig({
    namespace: "pgPolymorphism",
    initialCache() {
      return EMPTY_OBJECT;
    },
    initialState() {
      return EMPTY_OBJECT;
    },
    helpers: {},
    hooks: {
      async pgCodecs_recordType_spec(info, event) {
        const { pgClass, spec, serviceName } = event;
        const extensions: PgCodecExtensions =
          spec.extensions ?? Object.create(null);
        if (!spec.extensions) {
          spec.extensions = extensions;
        }
        const interfaceTag =
          extensions.tags.interface ?? pgClass.getTags().interface;
        if (interfaceTag) {
          if (typeof interfaceTag !== "string") {
            throw new Error(
              "Invalid 'interface' smart tag; string expected. Did you add too many?",
            );
          }
          const { params } = parseSmartTagsOptsString<"type" | "mode" | "name">(
            interfaceTag,
            0,
          );
          switch (params.mode) {
            case "single": {
              const { type = "type" } = params;
              const attr = pgClass.getAttribute({ name: type });
              if (!attr) {
                throw new Error(
                  `Invalid '@interface' smart tag - there is no '${type}' attribute on ${
                    pgClass.getNamespace()!.nspname
                  }.${pgClass.relname}`,
                );
              }

              const rawTypeTags = extensions.tags.type;
              const typeTags = Array.isArray(rawTypeTags)
                ? rawTypeTags.map((t) => String(t))
                : [String(rawTypeTags)];

              const attributeNames = pgClass
                .getAttributes()
                .filter((a) => a.attnum >= 1)
                .map((a) => a.attname);

              const types: PgCodecPolymorphismSingle["types"] =
                Object.create(null);
              const specificAttributes = new Set<string>();
              for (const typeTag of typeTags) {
                const {
                  args: [typeValue],
                  params: { name, attributes },
                } = parseSmartTagsOptsString<"name" | "attributes">(typeTag, 1);
                if (!name) {
                  throw new Error(`Every type must have a name`);
                }
                types[typeValue] = {
                  name,
                  attributes: attributes?.split(",").map(parseAttribute) ?? [],
                };
                for (const col of types[typeValue].attributes) {
                  specificAttributes.add(col.attribute);
                }
              }

              const commonAttributes = attributeNames.filter(
                (n) => !specificAttributes.has(n),
              );
              spec.polymorphism = {
                mode: "single",
                commonAttributes,
                typeAttributes: [type],
                types,
              };
              break;
            }
            case "relational": {
              const { type = "type" } = params;
              const attr = pgClass.getAttribute({ name: type });
              if (!attr) {
                throw new Error(
                  `Invalid '@interface' smart tag - there is no '${type}' attribute on ${
                    pgClass.getNamespace()!.nspname
                  }.${pgClass.relname}`,
                );
              }

              const rawTypeTags = extensions.tags.type;
              const typeTags = Array.isArray(rawTypeTags)
                ? rawTypeTags.map((t) => String(t))
                : [String(rawTypeTags)];

              const types: PgCodecPolymorphismRelational["types"] =
                Object.create(null);
              for (const typeTag of typeTags) {
                const {
                  args: [typeValue],
                  params: { references },
                } = parseSmartTagsOptsString<"references">(typeTag, 1);
                if (!references) {
                  throw new Error(
                    `@type of an @interface(mode:relational) must have a 'references:' parameter`,
                  );
                }
                const [namespaceName, tableName] = parseDatabaseIdentifier(
                  references,
                  2,
                  pgClass.getNamespace()?.nspname,
                );
                const referencedClass =
                  await info.helpers.pgIntrospection.getClassByName(
                    serviceName,
                    namespaceName,
                    tableName,
                  );
                if (!referencedClass) {
                  throw new Error(
                    `Could not find referenced class '${namespaceName}.${tableName}'`,
                  );
                }
                const pk = pgClass
                  .getConstraints()
                  .find((c) => c.contype === "p");
                const remotePk = referencedClass
                  .getConstraints()
                  .find((c) => c.contype === "p");
                if (!pk || !remotePk) {
                  throw new Error(
                    "Could not build polymorphic reference due to missing primary key",
                  );
                }
                const pgConstraint = referencedClass
                  .getConstraints()
                  .find(
                    (c) =>
                      c.contype === "f" &&
                      c.confrelid === pgClass._id &&
                      arraysMatch(
                        c.getAttributes()!,
                        remotePk.getAttributes()!,
                      ) &&
                      arraysMatch(
                        c.getForeignAttributes()!,
                        pk.getAttributes()!,
                      ),
                  );
                if (!pgConstraint) {
                  throw new Error(
                    "Could not build polymorphic reference due to missing foreign key constraint",
                  );
                }
                const codec = await info.helpers.pgCodecs.getCodecFromClass(
                  serviceName,
                  referencedClass._id,
                );
                types[typeValue] = {
                  name: info.inflection.tableType(codec!),
                  references,
                  relationName: info.inflection.resourceRelationName({
                    serviceName,
                    isReferencee: true,
                    isUnique: true,
                    localClass: pgClass,
                    localAttributes: pk.getAttributes()!,
                    foreignClass: referencedClass,
                    foreignAttributes: remotePk.getAttributes()!,
                    pgConstraint,
                  }),
                };
              }

              spec.polymorphism = {
                mode: "relational",
                typeAttributes: [type],
                types,
              };
              break;
            }
            case "union": {
              spec.polymorphism = {
                mode: "union",
              };
              break;
            }
            default: {
              throw new Error(`Unsupported (or not provided) @interface mode`);
            }
          }
        }
      },
      async pgRegistry_PgRegistryBuilder_finalize(info, event) {
        const { registryBuilder } = event;
        const registryConfig = registryBuilder.getRegistryConfig();
        for (const resource of Object.values(
          registryConfig.pgResources,
        ) as PgResourceOptions[]) {
          if (resource.parameters || !resource.codec.attributes) {
            continue;
          }
          if (!resource.extensions?.pg) {
            continue;
          }
          const {
            schemaName: resourceSchemaName,
            serviceName,
            name: resourceClassName,
          } = resource.extensions.pg;

          const pgClass = await info.helpers.pgIntrospection.getClassByName(
            serviceName,
            resourceSchemaName,
            resourceClassName,
          );
          if (!pgClass) {
            continue;
          }

          const poly = (resource.codec as PgCodec).polymorphism;
          if (poly?.mode === "relational") {
            // Copy common attributes to implementations
            for (const spec of Object.values(poly.types)) {
              const [schemaName, tableName] = parseDatabaseIdentifier(
                spec.references,
                2,
                resourceSchemaName,
              );
              const pgRelatedClass =
                await info.helpers.pgIntrospection.getClassByName(
                  serviceName,
                  schemaName,
                  tableName,
                );
              if (!pgRelatedClass) {
                throw new Error(
                  `Invalid reference to '${spec.references}' - cannot find that table (${schemaName}.${tableName})`,
                );
              }
              const otherCodec = await info.helpers.pgCodecs.getCodecFromClass(
                serviceName,
                pgRelatedClass._id,
              );
              if (!otherCodec || !otherCodec.attributes) {
                continue;
              }
              const pk = pgRelatedClass
                .getConstraints()
                .find((c) => c.contype === "p");
              if (!pk) {
                throw new Error(
                  `Invalid polymorphic relation; ${pgRelatedClass.relname} has no primary key`,
                );
              }
              const remotePk = pgClass
                .getConstraints()
                .find((c) => c.contype === "p");
              if (!remotePk) {
                throw new Error(
                  `Invalid polymorphic relation; ${pgClass.relname} has no primary key`,
                );
              }
              const pgConstraint = pgRelatedClass
                .getConstraints()
                .find(
                  (c) =>
                    c.contype === "f" &&
                    c.confrelid === pgClass._id &&
                    arraysMatch(
                      c.getForeignAttributes()!,
                      remotePk.getAttributes()!,
                    ) &&
                    arraysMatch(c.getAttributes()!, pk.getAttributes()!),
                );
              if (!pgConstraint) {
                throw new Error(
                  `Invalid polymorphic relation; could not find matching relation between ${pgClass.relname} and ${pgRelatedClass.relname}`,
                );
              }
              const sharedRelationName = info.inflection.resourceRelationName({
                serviceName,
                isReferencee: false,
                isUnique: true,
                localClass: pgRelatedClass,
                localAttributes: pk.getAttributes()!,
                foreignClass: pgClass,
                foreignAttributes: remotePk.getAttributes()!,
                pgConstraint,
              });

              for (const [colName, colSpec] of Object.entries(
                resource.codec.attributes,
              )) {
                if (otherCodec.attributes[colName]) {
                  otherCodec.attributes[colName].identicalVia =
                    sharedRelationName;
                } else {
                  otherCodec.attributes[colName] = {
                    codec: colSpec.codec,
                    notNull: colSpec.notNull,
                    hasDefault: colSpec.hasDefault,
                    via: sharedRelationName,
                    restrictedAccess: colSpec.restrictedAccess,
                    description: colSpec.description,
                    extensions: { ...colSpec.extensions },
                  };
                }
              }
            }
          }
        }
      },

      async pgRegistry_PgRegistry(info, event) {
        // We're creating 'refs' for the polymorphism. This needs to use the
        // same relationship names as we will in the GraphQL schema, so we need
        // to use the final PgRegistry, not the PgRegistryBuilder.

        const { registry } = event;
        for (const rawResource of Object.values(registry.pgResources)) {
          if (rawResource.parameters || !rawResource.codec.attributes) {
            continue;
          }
          const resource = rawResource as PgResource<
            string,
            PgCodecWithAttributes,
            any,
            undefined,
            PgRegistry
          >;
          if (!resource.extensions?.pg) {
            continue;
          }
          const {
            schemaName: resourceSchemaName,
            serviceName,
            name: resourceClassName,
          } = resource.extensions.pg;

          const pgClass = await info.helpers.pgIntrospection.getClassByName(
            serviceName,
            resourceSchemaName,
            resourceClassName,
          );
          if (!pgClass) {
            continue;
          }

          const relations = registry.pgRelations[resource.codec.name] as Record<
            string,
            PgCodecRelation
          >;
          const poly = (resource.codec as PgCodec).polymorphism;
          if (poly?.mode === "relational") {
            // Copy common attributes to implementations
            for (const spec of Object.values(poly.types)) {
              const [schemaName, tableName] = parseDatabaseIdentifier(
                spec.references,
                2,
                resourceSchemaName,
              );
              const pgRelatedClass =
                await info.helpers.pgIntrospection.getClassByName(
                  serviceName,
                  schemaName,
                  tableName,
                );
              if (!pgRelatedClass) {
                throw new Error(
                  `Invalid reference to '${spec.references}' - cannot find that table (${schemaName}.${tableName})`,
                );
              }
              const otherCodec = await info.helpers.pgCodecs.getCodecFromClass(
                serviceName,
                pgRelatedClass._id,
              );
              if (!otherCodec) {
                continue;
              }
              const pk = pgRelatedClass
                .getConstraints()
                .find((c) => c.contype === "p");
              if (!pk) {
                throw new Error(
                  `Invalid polymorphic relation; ${pgRelatedClass.relname} has no primary key`,
                );
              }
              const remotePk = pgClass
                .getConstraints()
                .find((c) => c.contype === "p");
              if (!remotePk) {
                throw new Error(
                  `Invalid polymorphic relation; ${pgClass.relname} has no primary key`,
                );
              }
              const pgConstraint = pgRelatedClass
                .getConstraints()
                .find(
                  (c) =>
                    c.contype === "f" &&
                    c.confrelid === pgClass._id &&
                    arraysMatch(
                      c.getForeignAttributes()!,
                      remotePk.getAttributes()!,
                    ) &&
                    arraysMatch(c.getAttributes()!, pk.getAttributes()!),
                );
              if (!pgConstraint) {
                throw new Error(
                  `Invalid polymorphic relation; could not find matching relation between ${pgClass.relname} and ${pgRelatedClass.relname}`,
                );
              }
              const sharedRelationName = info.inflection.resourceRelationName({
                serviceName,
                isReferencee: false,
                isUnique: true,
                localClass: pgRelatedClass,
                localAttributes: pk.getAttributes()!,
                foreignClass: pgClass,
                foreignAttributes: remotePk.getAttributes()!,
                pgConstraint,
              });

              const otherResourceOptions =
                await info.helpers.pgTables.getResourceOptions(
                  serviceName,
                  pgRelatedClass,
                );

              for (const [relationName, relationSpec] of Object.entries(
                relations,
              )) {
                // TODO: normally we wouldn't call `getBehavior` anywhere
                // except in an entityBehavior definition... Should this be
                // solved a different way?
                const behavior = getBehavior([
                  relationSpec.remoteResource.codec.extensions,
                  relationSpec.remoteResource.extensions,
                  relationSpec.extensions,
                ]);
                const relationDetails: GraphileBuild.PgRelationsPluginRelationDetails =
                  {
                    registry: resource.registry,
                    codec: resource.codec,
                    relationName,
                  };
                const singleRecordFieldName = relationSpec.isReferencee
                  ? info.inflection.singleRelationBackwards(relationDetails)
                  : info.inflection.singleRelation(relationDetails);
                const connectionFieldName =
                  info.inflection.manyRelationConnection(relationDetails);
                const listFieldName =
                  info.inflection.manyRelationList(relationDetails);
                const definition: PgRefDefinition = {
                  singular: relationSpec.isUnique,
                  singleRecordFieldName,
                  listFieldName,
                  connectionFieldName,
                  extensions: {
                    tags: {
                      behavior,
                    },
                  },
                };
                const ref: PgCodecRef = {
                  definition,
                  paths: [
                    [
                      {
                        relationName: sharedRelationName,
                      },
                      { relationName },
                    ],
                  ],
                };
                if (!otherResourceOptions!.codec.refs) {
                  otherResourceOptions!.codec.refs = Object.create(
                    null,
                  ) as Record<string, any>;
                }
                otherResourceOptions!.codec.refs[relationName] = ref;
              }
            }
          }
        }
      },
    },
  }),
  schema: {
    entityBehavior: {
      pgCodec: {
        provides: ["default"],
        before: ["inferred", "override"],
        callback(behavior, codec) {
          return [
            "select",
            "table",
            ...(!codec.isAnonymous ? ["insert", "update"] : []),
            behavior,
          ];
        },
      },
      pgCodecRelation: {
        provides: ["inferred"],
        after: ["default", "PgRelationsPlugin"],
        before: ["override"],
        callback(behavior, entity, build) {
          const {
            input: {
              pgRegistry: { pgRelations },
            },
          } = build;
          const { localCodec, remoteResource, isUnique, isReferencee } = entity;
          const remoteCodec = remoteResource.codec;

          // Hide relation from a concrete type back to the abstract root table.
          if (
            isUnique &&
            !isReferencee &&
            remoteCodec.polymorphism?.mode === "relational"
          ) {
            const localTypeName = build.inflection.tableType(localCodec);
            const polymorphicTypeDefinitionEntry = Object.entries(
              remoteCodec.polymorphism.types,
            ).find(([, val]) => val.name === localTypeName);
            if (polymorphicTypeDefinitionEntry) {
              const [, { relationName }] = polymorphicTypeDefinitionEntry;
              const relation = pgRelations[remoteCodec.name]?.[relationName];
              if (
                arraysMatch(relation.remoteAttributes, entity.localAttributes)
              ) {
                return [behavior, "-connection -list -single"];
              }
            }
          }

          // Hide relation from abstract root table to related elements
          if (isReferencee && localCodec.polymorphism?.mode === "relational") {
            const relations = Object.values(localCodec.polymorphism.types).map(
              (t) => pgRelations[localCodec.name]?.[t.relationName],
            );
            if (relations.includes(entity)) {
              return [behavior, "-connection -list -single"];
            }
          }

          return behavior;
        },
      },
    },
    hooks: {
      init(_, build, _context) {
        const {
          inflection,
          options: { pgForbidSetofFunctionsToReturnNull },
          setGraphQLTypeForPgCodec,
        } = build;
        const unionsToRegister = new Map<string, PgCodec[]>();
        for (const codec of build.pgCodecMetaLookup.keys()) {
          if (!codec.attributes) {
            // Only apply to codecs that define attributes
            continue;
          }

          // We're going to scan for interfaces, and then unions. Each block is
          // separately recoverable so an interface failure doesn't cause
          // unions to fail.

          // Detect interface
          build.recoverable(null, () => {
            const polymorphism = codec.polymorphism;
            if (!polymorphism) {
              // Don't build polymorphic types as objects
              return;
            }

            const isTable = build.behavior.pgCodecMatches(codec, "table");
            if (!isTable || codec.isAnonymous) {
              return;
            }

            const selectable = build.behavior.pgCodecMatches(codec, "select");

            if (selectable) {
              if (
                polymorphism.mode === "single" ||
                polymorphism.mode === "relational"
              ) {
                const interfaceTypeName = inflection.tableType(codec);
                build.registerInterfaceType(
                  interfaceTypeName,
                  {
                    pgCodec: codec,
                    isPgPolymorphicTableType: true,
                    pgPolymorphism: polymorphism,
                  },
                  () => ({
                    description: codec.description,
                  }),
                  `PgPolymorphismPlugin single/relational interface type for ${codec.name}`,
                );
                setGraphQLTypeForPgCodec(codec, ["output"], interfaceTypeName);
                build.registerCursorConnection({
                  typeName: interfaceTypeName,
                  connectionTypeName: inflection.tableConnectionType(codec),
                  edgeTypeName: inflection.tableEdgeType(codec),
                  scope: {
                    isPgConnectionRelated: true,
                    pgCodec: codec,
                  },
                  nonNullNode: pgForbidSetofFunctionsToReturnNull,
                });
                for (const [typeIdentifier, spec] of Object.entries(
                  polymorphism.types,
                ) as Array<
                  [
                    string,
                    (
                      | PgCodecPolymorphismSingleTypeSpec
                      | PgCodecPolymorphismRelationalTypeSpec
                    ),
                  ]
                >) {
                  const tableTypeName = spec.name;
                  if (polymorphism.mode === "single") {
                    build.registerObjectType(
                      tableTypeName,
                      {
                        pgCodec: codec,
                        isPgClassType: true,
                        pgPolymorphism: polymorphism,
                        pgPolymorphicSingleTableType: {
                          typeIdentifier,
                          name: spec.name,
                          attributes: (
                            spec as PgCodecPolymorphismSingleTypeSpec
                          ).attributes,
                        },
                      },
                      () => ({
                        assertStep: assertPgClassSingleStep,
                        description: codec.description,
                        interfaces: [
                          build.getTypeByName(
                            interfaceTypeName,
                          ) as GraphQLInterfaceType,
                        ],
                      }),
                      `PgPolymorphismPlugin single table type for ${codec.name}`,
                    );
                    build.registerCursorConnection({
                      typeName: tableTypeName,
                      connectionTypeName:
                        inflection.connectionType(tableTypeName),
                      edgeTypeName: inflection.edgeType(tableTypeName),
                      scope: {
                        isPgConnectionRelated: true,
                        pgCodec: codec,
                      },
                      nonNullNode: pgForbidSetofFunctionsToReturnNull,
                    });
                  }
                }
              } else if (polymorphism.mode === "union") {
                const interfaceTypeName = inflection.tableType(codec);
                build.registerInterfaceType(
                  interfaceTypeName,
                  {
                    pgCodec: codec,
                    isPgPolymorphicTableType: true,
                    pgPolymorphism: polymorphism,
                  },
                  () => ({
                    description: codec.description,
                  }),
                  `PgPolymorphismPlugin union interface type for ${codec.name}`,
                );
                setGraphQLTypeForPgCodec(codec, ["output"], interfaceTypeName);
                build.registerCursorConnection({
                  typeName: interfaceTypeName,
                  connectionTypeName: inflection.tableConnectionType(codec),
                  edgeTypeName: inflection.tableEdgeType(codec),
                  scope: {
                    isPgConnectionRelated: true,
                    pgCodec: codec,
                  },
                  nonNullNode: pgForbidSetofFunctionsToReturnNull,
                });
              }
            }
          });

          // Detect union membership
          build.recoverable(null, () => {
            const rawUnionMember = codec.extensions?.tags?.unionMember;
            if (rawUnionMember) {
              const memberships = Array.isArray(rawUnionMember)
                ? rawUnionMember
                : [rawUnionMember];
              for (const membership of memberships) {
                // Register union
                const unionName = membership.trim();
                const list = unionsToRegister.get(unionName);
                if (!list) {
                  unionsToRegister.set(unionName, [codec]);
                } else {
                  list.push(codec);
                }
              }
            }
          });
        }

        for (const [unionName, codecs] of unionsToRegister.entries()) {
          build.recoverable(null, () => {
            build.registerUnionType(
              unionName,
              { isPgUnionMemberUnion: true },
              () => ({
                types: () =>
                  codecs
                    .map(
                      (codec) =>
                        build.getTypeByName(
                          build.inflection.tableType(codec),
                        ) as GraphQLObjectType | undefined,
                    )
                    .filter(isNotNullish),
              }),
              "PgPolymorphismPlugin @unionMember unions",
            );
          });
        }
        return _;
      },
      GraphQLObjectType_interfaces(interfaces, build, context) {
        const { inflection } = build;
        const {
          scope: { pgCodec, isPgClassType },
        } = context;
        const rawImplements = pgCodec?.extensions?.tags?.implements;
        if (rawImplements && isPgClassType) {
          const interfaceNames = Array.isArray(rawImplements)
            ? rawImplements
            : [rawImplements];
          for (const interfaceName of interfaceNames) {
            const interfaceType = build.getTypeByName(String(interfaceName));
            if (!interfaceType) {
              console.error(`'${interfaceName}' type not found`);
            } else if (!build.graphql.isInterfaceType(interfaceType)) {
              console.error(
                `'${interfaceName}' is not an interface type (it's a ${interfaceType.constructor.name})`,
              );
            } else {
              interfaces.push(interfaceType);
            }
          }
        }
        for (const codec of build.pgCodecMetaLookup.keys()) {
          const polymorphism = codec.polymorphism;
          if (
            !codec.attributes ||
            !polymorphism ||
            polymorphism.mode !== "relational"
          ) {
            continue;
          }
          const typeNames = Object.values(polymorphism.types).map(
            (t) => t.name,
          );
          if (typeNames.includes(context.Self.name)) {
            const interfaceTypeName = inflection.tableType(codec);
            interfaces.push(
              build.getTypeByName(interfaceTypeName) as GraphQLInterfaceType,
            );
          }
        }
        return interfaces;
      },
      GraphQLSchema_types(types, build, _context) {
        for (const type of Object.values(build.getAllTypes())) {
          if (build.graphql.isInterfaceType(type)) {
            const scope = build.scopeByType.get(type) as
              | GraphileBuild.ScopeInterface
              | undefined;
            if (scope) {
              const polymorphism = scope.pgPolymorphism;
              if (polymorphism) {
                switch (polymorphism.mode) {
                  case "relational":
                  case "single": {
                    for (const type of Object.values(polymorphism.types)) {
                      // Force the type to be built
                      const t = build.getTypeByName(
                        type.name,
                      ) as GraphQLNamedType;
                      types.push(t);
                    }
                  }
                }
              }
            }
          }
        }
        return types;
      },
    },
  },
};
