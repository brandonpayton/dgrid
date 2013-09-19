define(["dojo/_base/kernel", "dojo/_base/declare", "dojo/_base/lang", "dojo/_base/Deferred", "dojo/on", "dojo/aspect", "put-selector/put"],
function(kernel, declare, lang, Deferred, listen, aspect, put){
	// This module isolates the base logic required by collection-aware list/grid
	// components, e.g. OnDemandList/Grid and the Pagination extension.
	
	// Noop function, needed for _trackError when callback due to a bug in 1.8
	// (see http://bugs.dojotoolkit.org/ticket/16667)
	function noop(value){ return value; }
	
	function emitError(err){
		// called by _trackError in context of list/grid, if an error is encountered
		if(typeof err !== "object"){
			// Ensure we actually have an error object, so we can attach a reference.
			err = new Error(err);
		}else if(err.dojoType === "cancel"){
			// Don't fire dgrid-error events for errors due to canceled requests
			// (unfortunately, the Deferred instrumentation will still log them)
			return;
		}
		// TODO: remove this @ 0.4 (prefer grid property directly on event object)
		err.grid = this;
		
		if(listen.emit(this.domNode, "dgrid-error", {
				grid: this,
				error: err,
				cancelable: true,
				bubbles: true })){
			console.error(err);
		}
	}
	
	return declare(null, {
		// collection: Object
		//		The collection object
		collection: null,
		
		// getBeforePut: boolean
		//		If true, a get request will be performed to the collection before each put
		//		as a baseline when saving; otherwise, existing row data will be used.
		getBeforePut: true,
		
		// noDataMessage: String
		//		Message to be displayed when a collection has no items
		//		Defined by _StoreMixin, but to be implemented by subclasses.
		noDataMessage: "",
		
		// loadingMessage: String
		//		Message displayed when data is loading.
		//		Defined by _StoreMixin, but to be implemented by subclasses.
		loadingMessage: "",
		
		constructor: function(){
			// Create empty objects on each instance, not the prototype
			this.dirty = {};
			this._updating = {}; // Tracks rows that are mid-update
			this._columnsWithSet = {};

			// Reset _columnsWithSet whenever column configuration is reset
			aspect.before(this, "configStructure", lang.hitch(this, function(){
				this._columnsWithSet = {};
			}));
		},

		postscript: function(){
			this.inherited(arguments);
			if(this.collection && !this._originalCollection){
				this._originalCollection = this.collection;
			}
		},
		
		postCreate: function(){
			this.inherited(arguments);
			if(this.collection){
				this._updateNotifyHandle(this.collection);
			}
		},
		
		destroy: function(){
			this.inherited(arguments);
			if(this._notifyHandle){
				this._notifyHandle.remove();
			}
		},
		
		_configColumn: function(column){
			// summary:
			//		Implements extension point provided by Grid to collection references to
			//		any columns with `set` methods, for use during `save`.
			if (column.set){
				this._columnsWithSet[column.field] = column;
			}
		},
		
		_updateNotifyHandle: function(collection){
			// summary:
			//		Unhooks any previously-existing collection.notify handle, and
			//		hooks up a new one for the given collection.
			
			if(this._notifyHandle){
				// Unhook notify handler from previous collection
				this._notifyHandle.remove();
				delete this._notifyHandle;
			}
			if(collection && typeof collection.notify === "function"){
				this._notifyHandle = aspect.after(collection, "notify",
					lang.hitch(this, "_onNotify"), true);
			}
		},
		
		_setCollection: function(collection){
			// summary:
			//		Assigns a new collection to the list,
			//		and tells it to refresh.
			
			this._updateNotifyHandle(collection);
			
			this.collection = collection;

			this.dirty = {}; // discard dirty map, as it applied to a previous collection

			this._updateSortedCollection();
		},
		
		sortedCollection: null,
		_setSort: function(property, descending){
			// summary:
			//		Sort the content

			// prevent default collectionless sort logic as long as we have a collection
			if(this.collection){ this._lastCollection = null; }

			this.inherited(arguments);
			this._updateSortedCollection();
		},

		_updateSortedCollection: function(){
			// TODO: Document this
			console.log("updateSortedCollection")

			var sortedCollection = this.collection,
				sort = this._sort;
			for(var i = 0; i < sort.length; ++i){
				sortedCollection = sortedCollection.sort(sort[i].attribute, sort[i].descending);
			}
			this.sortedCollection = sortedCollection;

			this.refresh();
		},
		
		_onNotify: function(object, existingId){
			// summary:
			//		Method called when the collection's notify method is called.
			
			// Call inherited in case anything was mixed in earlier
			this.inherited(arguments);
			
			// For adds/puts, check whether any observers are hooked up;
			// if not, force a refresh to properly hook one up now that there is data
			if(object && this._numObservers < 1){
				this.refresh({ keepScrollPosition: true });
			}
		},
		
		insertRow: function(object, parent, beforeNode, i, options){
			var collection = this.collection,
				dirty = this.dirty,
				id = collection && collection.getIdentity(object),
				dirtyObj;
			
			if(id in dirty && !(id in this._updating)){ dirtyObj = dirty[id]; }
			if(dirtyObj){
				// restore dirty object as delegate on top of original object,
				// to provide protection for subsequent changes as well
				object = lang.delegate(object, dirtyObj);
			}
			return this.inherited(arguments);
		},
		
		updateDirty: function(id, field, value){
			// summary:
			//		Updates dirty data of a field for the item with the specified ID.
			var dirty = this.dirty,
				dirtyObj = dirty[id];
			
			if(!dirtyObj){
				dirtyObj = dirty[id] = {};
			}
			dirtyObj[field] = value;
		},
		setDirty: function(id, field, value){
			kernel.deprecated("setDirty(...)", "use updateDirty() instead", "dgrid 0.4");
			this.updateDirty(id, field, value);
		},
		
		save: function() {
			// Keep track of the collection and puts
			var self = this,
				collection = this.collection,
				dirty = this.dirty,
				dfd = new Deferred(), promise = dfd.promise,
				getFunc = function(id){
					// returns a function to pass as a step in the promise chain,
					// with the id variable closured
					var data;
					return (self.getBeforePut || !(data = self.row(id).data)) ?
						function(){ return collection.get(id); } :
						function(){ return data; };
				};
			
			// function called within loop to generate a function for putting an item
			function putter(id, dirtyObj) {
				// Return a function handler
				return function(object) {
					var colsWithSet = self._columnsWithSet,
						updating = self._updating,
						key, data;

					if (typeof object.set === "function") {
						object.set(dirtyObj);
					} else {
						// Copy dirty props to the original, applying setters if applicable
						for(key in dirtyObj){
							object[key] = dirtyObj[key];
						}
					}

					// Apply any set methods in column definitions.
					// Note that while in the most common cases column.set is intended
					// to return transformed data for the key in question, it is also
					// possible to directly modify the object to be saved.
					for(key in colsWithSet){
						data = colsWithSet[key].set(object);
						if(data !== undefined){ object[key] = data; }
					}
					
					updating[id] = true;
					// Put it in the collection, returning the result/promise
					return Deferred.when(collection.put(object), function() {
						// Clear the item now that it's been confirmed updated
						delete dirty[id];
						delete updating[id];
					});
				};
			}
			
			// For every dirty item, grab the ID
			for(var id in dirty) {
				// Create put function to handle the saving of the the item
				var put = putter(id, dirty[id]);
				
				// Add this item onto the promise chain,
				// getting the item from the collection first if desired.
				promise = promise.then(getFunc(id)).then(put);
			}
			
			// Kick off and return the promise representing all applicable get/put ops.
			// If the success callback is fired, all operations succeeded; otherwise,
			// save will stop at the first error it encounters.
			dfd.resolve();
			return promise;
		},
		
		revert: function(){
			// summary:
			//		Reverts any changes since the previous save.
			this.dirty = {};
			this.refresh();
		},
		
		_trackError: function(func){
			// summary:
			//		Utility function to handle emitting of error events.
			// func: Function|String
			//		A function which performs some collection operation, or a String identifying
			//		a function to be invoked (sans arguments) hitched against the instance.
			//		If sync, it can return a value, but may throw an error on failure.
			//		If async, it should return a promise, which would fire the error
			//		callback on failure.
			// tags:
			//		protected
			
			var result;
			
			if(typeof func == "string"){ func = lang.hitch(this, func); }
			
			try{
				result = func();
			}catch(err){
				// report sync error
				emitError.call(this, err);
			}
			
			// wrap in when call to handle reporting of potential async error
			return Deferred.when(result, noop, lang.hitch(this, emitError));
		},
		
		newRow: function(){
			// Override to remove no data message when a new row appears.
			// Run inherited logic first to prevent confusion due to noDataNode
			// no longer being present as a sibling.
			var row = this.inherited(arguments);
			if(this.noDataNode){
				put(this.noDataNode, "!");
				delete this.noDataNode;
			}
			return row;
		},
		removeRow: function(rowElement, justCleanup){
			var row = {element: rowElement};
			// Check to see if we are now empty...
			if(!justCleanup && this.noDataMessage &&
					(this.up(row).element === rowElement) &&
					(this.down(row).element === rowElement)){
				// ...we are empty, so show the no data message.
				this.noDataNode = put(this.contentNode, "div.dgrid-no-data");
				this.noDataNode.innerHTML = this.noDataMessage;
			}
			return this.inherited(arguments);
		}
	});
});
