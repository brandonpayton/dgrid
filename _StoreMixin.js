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
		//		The object collection (implementing the dstore/api/Store API) from which data is
		//		to be fetched.
		collection: null,

		_sortedCollection: null,

		_observedCollection: null,

		_renderedCollection: null,

		rows: null,

		// getBeforePut: boolean
		//		If true, a get request will be performed to the collection before each put
		//		as a baseline when saving; otherwise, existing row data will be used.
		getBeforePut: true,

		// noDataMessage: String
		//		Message to be displayed when no results exist for a query, whether at
		//		the time of the initial query or upon subsequent observed changes.
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

			this.rows = [];

			// Reset _columnsWithSet whenever column configuration is reset
			aspect.before(this, "configStructure", lang.hitch(this, function(){
				this._columnsWithSet = {};
			}));
		},

		postscript: function(){
			// TODO: This is a stop-gap. What is the correct approach to calling setters on with kwArg properties in dgrid?
			this.inherited(arguments);
			this.collection && this.set('collection', this.collection);
			//this.sort && this.set('sort', sort);
		},

		destroy: function(){
			this.inherited(arguments);
			this._cleanupObserver();
		},

		_cleanupObserver: function(){
			if(this._observedCollection){
				this._observedCollection.remove();
				this._observedCollection = null;
			}
		},

		_addObserver: function(){
			var _sortedCollection = this._sortedCollection;
			if(_sortedCollection && _sortedCollection.observe){
				this._observedCollection = _sortedCollection.observe(lang.hitch(this, "_onNotification"));
			}
			this._renderedCollection = this._observedCollection || this._sortedCollection;
		},

		refresh: function(){
			// TODO: Revisit this. It is a hack.
			// Don't render without a `_renderedCollection`
			if(!this._renderedCollection) { return; }

			this.inherited(arguments);
		},

		_configColumn: function(column){
			// summary:
			//		Implements extension point provided by Grid to collection references to
			//		any columns with `set` methods, for use during `save`.
			if (column.set){
				this._columnsWithSet[column.field] = column;
			}
		},

		_setCollection: function(collection){
			// summary:
			//		Assigns a new collection and tells it to refresh.

			this.collection = collection;
			this.dirty = {}; // discard dirty map, as it applied to a previous collection
			this._applySort();
		},

		_applySort: function(){
			this._cleanupObserver();

			var _sortedCollection = this.collection,
				sort = this._sort;
			if(_sortedCollection){
				for(var i = 0; i < sort.length; ++i){
					_sortedCollection = _sortedCollection.sort(sort[i].attribute, sort[i].descending);
				}
				this._sortedCollection = _sortedCollection;

				this._addObserver();
				this.refresh();
			}
		},

		_setSort: function(property, descending){
			// summary:
			//		Sort the content

			// prevent default storeless sort logic as long as we have a collection
			if(this.collection){ this._lastCollection = null; }
			this.inherited(arguments);
			this._applySort();
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
		},


		renderQueryResults: function(results, beforeNode, options){
			// summary:
			//		Renders objects from QueryResults as rows, before the given node.
			//		This will listen for changes in the collection if an observe method
			//		is available (i.e. from an Observable data store).

			options = options || {};
			var self = this,
				start = options.start || 0,
				observer,
				rows = this.rows,
				container,
				observerIndex;

			// Render the results, asynchronously or synchronously
			// TODO: Fix this direct reference to `data` when dstore `then` method is added
			return Deferred.when(results.data, function(resolvedResults){
				var resolvedRows,
					i;

				container = beforeNode ? beforeNode.parentNode : self.contentNode;
				if(container && container.parentNode &&
						(container !== self.contentNode || resolvedResults.length)){
					resolvedRows = self.renderArray(resolvedResults, beforeNode, options);

					for(i = 0; i < resolvedRows.length; ++i){
						rows[start + i] = resolvedRows[i];
					}

					delete self._lastCollection; // used only for non-store List/Grid
				}else{
					// Don't bother inserting; rows are already out of view
					// or there were none to track
					resolvedRows = [];
				}
				return resolvedRows;
			});
		},

		_onNotification: function(type, target, info){
			// summary:
			//		Protected method called whenever a store notification is observed.
			//		Intended to be extended as necessary by mixins/extensions.
			var newIndex = info.index,
				previousIndex = info.previousIndex,
				rows = this.rows,
				row,
				firstRow,
				nextNode,
				parentNode;

			function advanceNext() {
				nextNode = (nextNode.connected || nextNode).nextSibling;
			}

			if(previousIndex !== undefined &&
				(type === "remove" || (type === "update" && previousIndex !== newIndex))){

				row = this.rows.splice(previousIndex, 1)[0];
				// TODO: Review. Is there a reason it is important to compare with `container` here?
				// if(row.parentNode == container){
				if(row && row.parentNode){
					firstRow = row.nextSibling;
					firstRow && firstRow.rowIndex--; // adjust the rowIndex so adjustRowIndices has the right starting point
					this.removeRow(row);

					// the removal of rows could cause us to need to page in more items
					if(this._processScroll){
						this._processScroll();
					}
				}
			}

			if(newIndex !== undefined && (type === "add" || type === "update")){
				// Only insert a row if it is in the neighborhood of existing rows.
				// Otherwise, we could insert a row that is not part of rendered ranges.
				if(rows[newIndex] || rows[newIndex + 1] || rows[newIndex - 1]){
					// Add to new slot (either before an existing row, or at the end)
					// First determine the DOM node that this should be placed before.
					if(rows.length){
						nextNode = rows[newIndex + 1];
						if(!nextNode){
							nextNode = rows[newIndex];
							if(nextNode){
								// Make sure to skip connected nodes, so we don't accidentally
								// insert a row in between a parent and its children.
								advanceNext();
							}
						}
					}else{
						// There are no rows.  Allow for subclasses to insert new rows somewhere other than
						// at the end of the parent node.
						nextNode = this._getFirstRowSibling && this._getFirstRowSibling(container);
					}
					// Make sure we don't trip over a stale reference to a
					// node that was removed, or try to place a node before
					// itthis (due to overlapped queries)
					if(row && nextNode && row.id === nextNode.id){
						advanceNext();
					}
					if(nextNode && !nextNode.parentNode){
						nextNode = byId(nextNode.id);
					}
					// TODO: Is missing `beforeNode` a problem here?
					parentNode = /*(beforeNode && beforeNode.parentNode) ||*/
						(nextNode && nextNode.parentNode) || this.contentNode;
					// TODO: Is missing `options` a problem here? Likely, dgrid/tree just needs to implement its own observable maintenance.
					row = this.insertRow(target, parentNode, nextNode, newIndex, {});
				}else{
					row = undefined;
				}
				rows.splice(newIndex, 0, row);
				this.highlightRow(row);
			}

			newIndex !== previousIndex && firstRow && this.adjustRowIndices(firstRow);
		}
	});
});
