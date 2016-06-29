import * as Promise from "bluebird";
import * as fiberBootstrap from "./fiber-bootstrap";
import * as assert from "assert";
import {isFuture} from "./helpers";

export function exportedPromise(moduleName: string, action?: Function): any {
	return (target: Object, propertyKey: string, descriptor: TypedPropertyDescriptor<any>): TypedPropertyDescriptor<any> => {
		$injector.publicApi.__modules__[moduleName] = $injector.publicApi.__modules__[moduleName] || {};
		$injector.publicApi.__modules__[moduleName][propertyKey] = (...args: any[]): Promise<any>[] | Promise<any> => {
			let originalModule = $injector.resolve(moduleName);
			let originalMethod: Function = originalModule[propertyKey];
			let result: any;
			try {
				result = originalMethod.apply(originalModule, args);
			} catch (err) {
				let promise = new Promise(function (onFulfilled: Function, onRejected: Function) {
					onRejected(err);
				});

				return promise;
			}

			let types = _(result)
				.groupBy((f: any) => typeof f)
				.keys()
				.value();

			let finalResult: any,
				arrayResult: Promise<any>[];
			// Check if method returns IFuture<T>[]. In this case we will return Promise<T>[]
			if (_.isArray(result) && types.length === 1 && isFuture(_.first<any>(result))) {
				finalResult = _.map(result, (future: IFuture<any>) => getPromise(future));
				arrayResult = finalResult;
			} else {
				finalResult = getPromise(result);
				arrayResult = [finalResult];
			}

			if (action) {
				let settledPromises = 0;
				_.each(arrayResult, (prom: Promise<any>) => {
					prom.lastly(() => {
						settledPromises++;
						if (settledPromises === arrayResult.length) {
							action.bind(originalModule)();
						}
					});
				});
			}

			return finalResult;
		};

		return descriptor;
	};
}

function getPromise(originalValue: any): Promise<any> {
	return new Promise(function (onFulfilled: Function, onRejected: Function) {
		if (isFuture(originalValue)) {
			fiberBootstrap.run(function () {
				try {
					let realResult = originalValue.wait();
					onFulfilled(realResult);
				} catch (err) {
					onRejected(err);
				}
			});
		} else {
			onFulfilled(originalValue);
		}
	});
}

export function exported(moduleName: string): any {
	return (target: Object, propertyKey: string, descriptor: TypedPropertyDescriptor<any>): TypedPropertyDescriptor<any> => {
		$injector.publicApi.__modules__[moduleName] = $injector.publicApi.__modules__[moduleName] || {};
		$injector.publicApi.__modules__[moduleName][propertyKey] = (...args: any[]): any => {
			let originalModule = $injector.resolve(moduleName);
			let originalMethod: any = target[propertyKey];
			let result = originalMethod.apply(originalModule, args);
			assert.strictEqual(isFuture(result), false, "Cannot use exported decorator with function returning IFuture<T>.");
			return result;
		};

		return descriptor;
	};
}