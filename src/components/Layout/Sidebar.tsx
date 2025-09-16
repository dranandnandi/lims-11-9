import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  TestTube,
  ClipboardList,
  FileText,
  Receipt, 
  DollarSign,
  Brain,
  Settings,
  X,
  Activity,
  CheckCircle2,
  Workflow,
  UserCheck,
  Building
} from 'lucide-react';interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
}

const navigation = [
  // Core Laboratory Workflow - Most Used Daily
  { name: 'Dashboard', href: '/', icon: LayoutDashboard, category: 'core' },
  { name: 'Orders', href: '/orders', icon: ClipboardList, category: 'core' },
  { name: 'Results Entry', href: '/results', icon: Activity, category: 'core' },
  { name: 'Results Verification', href: '/results-verification', icon: CheckCircle2, category: 'core' },
  { name: 'Reports', href: '/reports', icon: FileText, category: 'core' }, // Moved after Results Entry per request
  
  // Patient & Sample Management
  { name: 'Patients', href: '/patients', icon: Users, category: 'management' },
  { name: 'Tests & Samples', href: '/tests', icon: TestTube, category: 'management' },
  
  // Business & Administrative
  { name: 'Billing', href: '/billing', icon: Receipt, category: 'business' },
  { name: 'Cash Reconciliation', href: '/cash-reconciliation', icon: DollarSign, category: 'business' },
  
  // Master Data Management
  { name: 'Doctor Master', href: '/masters/doctors', icon: UserCheck, category: 'masters' },
  { name: 'Location Master', href: '/masters/locations', icon: Building, category: 'masters' },
  
  // Advanced Tools
  { name: 'AI Tools', href: '/ai-tools', icon: Brain, category: 'tools' },
  { name: 'Workflow Demo', href: '/workflow-demo', icon: Workflow, category: 'tools' },
  { name: 'Settings', href: '/settings', icon: Settings, category: 'tools' },
];

const Sidebar: React.FC<SidebarProps> = ({ isOpen, onToggle }) => {
  const location = useLocation();

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden" onClick={onToggle} />
      )}
      
      {/* Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out
        lg:translate-x-0 lg:static lg:inset-0
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex items-center justify-between h-16 px-6 bg-blue-600">
          <div className="flex items-center">
            <TestTube className="h-8 w-8 text-white" />
            <span className="ml-2 text-xl font-bold text-white">LIMS Builder</span>
          </div>
          <button
            onClick={onToggle}
            className="lg:hidden text-white hover:text-gray-200"
          >
            <X className="h-6 w-6" />
          </button>
        </div>
        
        <nav className="mt-8 px-4 space-y-1">
          {/* Core Laboratory Workflow */}
          <div className="mb-6">
            <h3 className="px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              🔬 Daily Operations
            </h3>
            {navigation.filter(item => item.category === 'core').map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 mb-1
                    border-l-4 border-l-blue-500
                    ${isActive
                      ? 'bg-blue-50 text-blue-700 border-l-blue-700'
                      : 'text-gray-600 hover:bg-blue-50 hover:text-blue-700 border-l-transparent hover:border-l-blue-300'
                    }
                  `}
                  onClick={() => window.innerWidth < 1024 && onToggle()}
                >
                  <item.icon className={`h-5 w-5 mr-3 ${isActive ? 'text-blue-700' : 'text-gray-400'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* Patient Management */}
          <div className="mb-6">
            <h3 className="px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              👥 Patient Management
            </h3>
            {navigation.filter(item => item.category === 'management').map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 mb-1
                    border-l-4 border-l-green-500
                    ${isActive
                      ? 'bg-green-50 text-green-700 border-l-green-700'
                      : 'text-gray-600 hover:bg-green-50 hover:text-green-700 border-l-transparent hover:border-l-green-300'
                    }
                  `}
                  onClick={() => window.innerWidth < 1024 && onToggle()}
                >
                  <item.icon className={`h-5 w-5 mr-3 ${isActive ? 'text-green-700' : 'text-gray-400'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* Business & Reports */}
          <div className="mb-6">
            <h3 className="px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              💼 Business & Reports
            </h3>
            {navigation.filter(item => item.category === 'business').map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 mb-1
                    border-l-4 border-l-purple-500
                    ${isActive
                      ? 'bg-purple-50 text-purple-700 border-l-purple-700'
                      : 'text-gray-600 hover:bg-purple-50 hover:text-purple-700 border-l-transparent hover:border-l-purple-300'
                    }
                  `}
                  onClick={() => window.innerWidth < 1024 && onToggle()}
                >
                  <item.icon className={`h-5 w-5 mr-3 ${isActive ? 'text-purple-700' : 'text-gray-400'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* Master Data Management */}
          <div className="mb-6">
            <h3 className="px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              📊 Master Data
            </h3>
            {navigation.filter(item => item.category === 'masters').map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 mb-1
                    border-l-4 border-l-orange-500
                    ${isActive
                      ? 'bg-orange-50 text-orange-700 border-l-orange-700'
                      : 'text-gray-600 hover:bg-orange-50 hover:text-orange-700 border-l-transparent hover:border-l-orange-300'
                    }
                  `}
                  onClick={() => window.innerWidth < 1024 && onToggle()}
                >
                  <item.icon className={`h-5 w-5 mr-3 ${isActive ? 'text-orange-700' : 'text-gray-400'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* Tools & Settings */}
          <div>
            <h3 className="px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              🛠️ Tools & Settings
            </h3>
            {navigation.filter(item => item.category === 'tools').map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 mb-1
                    border-l-4 border-l-gray-500
                    ${isActive
                      ? 'bg-gray-50 text-gray-700 border-l-gray-700'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-700 border-l-transparent hover:border-l-gray-300'
                    }
                  `}
                  onClick={() => window.innerWidth < 1024 && onToggle()}
                >
                  <item.icon className={`h-5 w-5 mr-3 ${isActive ? 'text-gray-700' : 'text-gray-400'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
};

export default Sidebar;