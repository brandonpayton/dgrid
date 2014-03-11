define([
	"dojo/_base/lang",
	"dojo/_base/Deferred",
	"dstore/Memory",
	"./typesData"
], function(lang, Deferred, Memory, typesData){
	// summary:
	//		Returns a hash containing stores which generate errors on specific
	//		methods, synchronously or asynchronously.

	var fetchStore = new Memory(),
		asyncFetchStore = new Memory(),
		asyncFetchTotalStore = new Memory(),
		putStore = new Memory({ data: lang.clone(typesData) }),
		asyncPutStore = new Memory({ data: lang.clone(typesData) });

	fetchStore.fetch = function() {
		throw new Error("Error on sync query");
	};

	putStore.put = function() {
		throw new Error("Error on sync put");
	};

	asyncFetchStore.fetch = function() {
		var dfd = new Deferred();
		setTimeout(function() { dfd.reject("Error on async query"); }, 200);
		this.total = 0;
		return dfd;
	};

	asyncFetchTotalStore.fetch = function () {
		this.total = new Deferred();
		this.total.reject("Error getting the total");
		return [];
	};

	asyncPutStore.put = function() {
		var dfd = new Deferred();
		setTimeout(function() { dfd.reject("Error on async put"); }, 200);
		return dfd.promise;
	};

	return {
		fetch: fetchStore,
		put: putStore,
		asyncFetch: asyncFetchStore,
		asyncFetchTotal: asyncFetchTotalStore,
		asyncPut: asyncPutStore
	};
});
