import fs from 'fs'
import path from 'path'
import { debug } from '../utils'
import { RuntimeException } from '../Exceptions'
import { BaseTask } from './Task'
import NodeSchedule from 'node-schedule'
import { IocContract } from '@adonisjs/fold'
import Logger from '@ioc:Adonis/Core/Logger'
import cronstrue from 'cronstrue'
import { glob } from 'glob'

/**
 * @module Scheduler
 * @description Task scheduler provider using node-schedule
 */
export default class Scheduler {
	private appRootPath: string
	private tasksPath: string
	private newTasksPath: string
	private registeredTasks: BaseTask[]
	/**
	 */
	constructor(appRootPath: string, protected container: IocContract, protected logger: typeof Logger) {
		this.appRootPath = appRootPath
		this.registeredTasks = []

		this._configureTasksPath()
	}

	/**
	 * Configure tasks absolute path for app
	 * /<project-dir>/app/Tasks
	 */
	private _configureTasksPath() {
		this.tasksPath = path.join(this.appRootPath, 'app', 'Tasks')
		this.tasksPath = path.normalize(this.tasksPath)

		this.newTasksPath = path.join(this.appRootPath, 'integrations')
	}

	/**
	 * Load task file
	 */
	private async _fetchTask(task: typeof BaseTask) {
		const taskInstance: BaseTask = this.container.make(task, [
			this.appRootPath + '/tmp/adonis5-scheduler/locks',
			this.logger,
		])
		const taskInstanceConstructor = taskInstance.constructor as typeof BaseTask
		// Every task must expose a schedule
		if (!('schedule' in taskInstanceConstructor)) {
			throw RuntimeException.undefinedTaskSchedule(task.constructor.name)
		}

		// Every task must expose a handle function
		if (!('handle' in taskInstance)) {
			throw RuntimeException.undefinedTaskHandle(task.constructor.name)
		}

		// if (!(taskInstance instanceof Task)) {
		// 	throw RuntimeException.undefinedInstanceTask(file)
		// }

		// Track currently registered tasks in memory
		this.registeredTasks.push(taskInstance)
		// Before add task to schedule need check & unlock file if exist
		const locked = await taskInstance.locker.check()
		if (locked) {
			await taskInstance.locker.unlock()
		}

		// Register task handler
		const humanCron = cronstrue.toString(taskInstanceConstructor.schedule)

		NodeSchedule.scheduleJob(taskInstanceConstructor.schedule, taskInstance._run.bind(taskInstance))
		this.logger.info(
			`Task ${taskInstanceConstructor.name} registered with schedule ${taskInstanceConstructor.schedule} (${humanCron})`
		)
	}

	public getRegisteredTasks() {
		return this.registeredTasks
	}

	/**
	 * Register scheduled tasks for every task found in app/Tasks
	 *
	 * @public
	 */
	public async run(taskClasses: Array<typeof BaseTask> = []) {
		debug('Scan tasks path %s', this.tasksPath)
		if (taskClasses.length === 0) {
			try {
				const tasksPaths = await glob(path.join(this.newTasksPath, '**', 'Tasks'))

				const paths = await Promise.all(
					tasksPaths.map((p) => {
						return {
							path: p,
							files: fs.readdirSync(p),
						}
					})
				)

				const taskFiles = paths.reduce(
					(acc, p) => {
						return [
							...acc,
							...p.files.map((f) => {
								return {
									path: p.path,
									file: f,
								}
							}),
						]
					},
					[] as {
						path: string
						file: string
					}[]
				)

				console.log(taskFiles)
				for (const file of taskFiles) {
					const isAllowed = ['.js', '.ts'].includes(path.extname(file.file)) && !file.file.includes('.map')
					if (isAllowed) {
						const filePath = path.join(file.path, file.file)
						let task: typeof BaseTask
						try {
							task = require(filePath).default
							await this._fetchTask(task)
						} catch (e) {
							if (e instanceof ReferenceError) {
								debug('Unable to import task class <%s>. Is it a valid javascript class?', file)
								return
							} else {
								throw e
							}
						}
					}
				}
			} catch (e) {
				// If the directory isn't found, log a message and exit gracefully
				if (e.code === 'ENOENT') {
					throw RuntimeException.notFoundTask(this.tasksPath)
				}
				throw e
			}
		}

		for (let task of taskClasses) {
			await this._fetchTask(task)
		}

		debug('scheduler running %d tasks', this.registeredTasks.length)
	}
}
