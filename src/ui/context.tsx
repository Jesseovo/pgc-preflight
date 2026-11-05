import {createContext,useContext,type ReactNode} from 'react';
export interface User{id:string;role:'admin'|'member';star:boolean;canReview:boolean;username?:string;displayName?:string;preview?:boolean}
export interface AppContextValue{user:User;pathname:string;params:URLSearchParams;navigate:(url:string,replace?:boolean)=>void;notify:(message:string,tone?:'success'|'error'|'info')=>void}
const Context=createContext<AppContextValue|null>(null);
export function AppProvider({value,children}:{value:AppContextValue;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useApp(){const value=useContext(Context);if(!value)throw Error('工作台尚未就绪');return value;}
