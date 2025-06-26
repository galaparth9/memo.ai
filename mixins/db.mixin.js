"use strict";
const DbService = require("moleculer-db");
const Mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

module.exports = function (collection) {
    const cacheCleanEventName = `cache.clean.${collection}`;
    let db = {};

    const schema = {
        mixins: [DbService],

        events: {
            async [cacheCleanEventName]() {
                if (this.broker.cacher) {
                    await this.broker.cacher.clean(`${this.fullName}.*`);
                }
            }
        },

        methods: {
            async entityChanged(type, json, ctx) {
                ctx.broadcast(cacheCleanEventName);
            },

            attachModels() {
                const schemaPath = path.join(__dirname, "../schema");

                fs.readdirSync(schemaPath)
                    .filter(file => file.endsWith(".js"))
                    .forEach(file => {
                        const modelName = file.replace(".js", "");
                        const model = require(path.join(schemaPath, file));
                        db[modelName] = model;
                    });
            },

            async connectToDb() {
                const uri = process.env.MONGO_URI
                return new Promise(async (resolve, reject) => {
                    try {
                        if (typeof uri !== 'undefined') {
                            await Mongoose.connect(uri);
                            this.attachModels();
                            this.logger.info("Successfully connected to MongoDB");
                            resolve(db);
                        } else {
                            reject("MongoDB URI is undefined. Check your environment variables.");
                        }
                    } catch (err) {
                        this.logger.error("MongoDB connection error:", err);
                        reject(err);
                    }
                });
            },

            async syncModels() {
                try {
                    for (const modelName of Object.keys(db)) {
                        const model = db[modelName];

                        if (model && typeof model.syncIndexes === 'function') {
                            await model.syncIndexes();
                            this.logger.info(`Indexes synchronized for model: ${modelName}`);
                        } else {
                            this.logger.warn(`Model ${modelName} does not have syncIndexes or is not a valid Mongoose model.`);
                        }
                    }
                    this.logger.info("All models synchronized with MongoDB.");
                } catch (error) {
                    this.logger.error("Error synchronizing models:", error);
                }
            }
        },

        async started() {
            try {
                this.db = await this.connectToDb();
                this.logger.info("Database connection established.");
                await this.syncModels();
            } catch (err) {
                this.logger.error("Failed to connect to the database:", err);
            }
        }
    };

    return schema;
};
