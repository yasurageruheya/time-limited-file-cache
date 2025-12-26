
class Super {
	#entry;
	#a = "bbb";
	constructor() {
		this.#entry = this;
	}
}

class Sub extends Super {
	#entry;
	get entry() { return this.#entry; }
	#a = "aaa";
	get a() { return this.#a; }
	constructor() {
		super();
	}
}
const sub = new Sub();
console.log(sub.entry);